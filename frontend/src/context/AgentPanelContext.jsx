import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { agentsApi, WS_BASE_URL } from '../api'
import { getAccessToken } from '../api/client'

// If the WebSocket never connects or drops mid-run, the agent keeps running
// server-side — so fall back to polling the REST endpoint instead of telling
// the user the run failed.
const POLL_INTERVAL_MS = 1500
const MAX_POLL_ATTEMPTS = 240 // ~6 min of "still running" before giving up
// A run that keeps reporting status='running' may legitimately take minutes;
// but this many *consecutive failed requests* (~12s) means the backend itself
// is unreachable, so fail fast instead of spinning silently.
const MAX_CONSECUTIVE_POLL_ERRORS = 8

const AgentPanelContext = createContext(null)

export function AgentPanelProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [currentRun, setCurrentRun] = useState(null)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState([])
  const wsRef = useRef(null)
  // Bumped by closeSocket(): async handlers belonging to an older run see a
  // stale generation and stop, so closing a socket can't keep polling for it.
  const generationRef = useRef(0)
  // Settles the in-flight run's promise when it gets superseded, so an
  // abandoned run never leaves its caller awaiting forever.
  const pendingRunRef = useRef(null)

  const closeSocket = useCallback(() => {
    generationRef.current += 1
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    const pending = pendingRunRef.current
    pendingRunRef.current = null
    if (pending) pending()
  }, [])

  /** Live-streaming run: kicks off the agent in the background, then opens a
   * WebSocket to watch each step arrive in real time (instead of waiting for
   * the whole run to finish before showing anything). If the socket fails —
   * handshake refused, proxy in the way, dropped connection — it silently
   * falls back to polling GET /agents/runs/{runId} so the panel still
   * completes with the real result. */
  const runAgent = useCallback(async (agentType, question, documentIds) => {
    closeSocket()
    setIsOpen(true)
    setIsRunning(true)
    setError(null)
    setCurrentRun({ agent_type: agentType, question, status: 'running', steps: [], result_text: null, result: null })

    let startData
    try {
      startData = await agentsApi.startStreaming(agentType, question, documentIds)
    } catch (err) {
      // The run never started (validation, rate limit, LLM not configured…).
      setIsRunning(false)
      setError(err.response?.data?.detail || 'The agent run failed. Please try again.')
      setCurrentRun((prev) => (prev ? { ...prev, status: 'failed' } : prev))
      throw err
    }

    const runId = startData.data.run_id
    const generation = generationRef.current

    return await new Promise((resolve, reject) => {
      let settled = false
      let polling = false
      let pollTimer = null
      let pollAttempts = 0
      let consecutiveErrors = 0
      let ws = null

      const isStale = () => generationRef.current !== generation
      const stopPolling = () => {
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
      }
      const closeSocketIfOpen = () => {
        if (ws) {
          try { ws.close() } catch { /* already closed */ }
        }
      }

      pendingRunRef.current = () => {
        if (settled) return
        settled = true
        stopPolling()
        resolve()
      }

      // Merge `updates` into whatever the panel is currently showing and,
      // if the run is over, push the finished run into history.
      const finish = (updates) => {
        if (settled || isStale()) return
        settled = true
        stopPolling()
        setIsRunning(false)
        setCurrentRun((prev) => {
          const finished = { ...(prev || { agent_type: agentType, question }), ...updates }
          setHistory((h) => [finished, ...h].slice(0, 20))
          return finished
        })
        if (updates.status === 'failed') setError(updates.error_message || 'The agent run failed.')
        closeSocketIfOpen()
        resolve()
      }

      const fail = (message) => {
        if (settled || isStale()) return
        settled = true
        stopPolling()
        setIsRunning(false)
        setError(message)
        setCurrentRun((prev) => (prev ? { ...prev, status: 'failed' } : prev))
        closeSocketIfOpen()
        const err = new Error(message)
        err.agentStreamFailure = true // caller can show the real reason
        reject(err)
      }

      const applySteps = (steps) => {
        setCurrentRun((prev) => {
          if (!prev) return prev
          const next = [...(prev.steps || [])]
          for (const s of steps || []) {
            next[s.step_index] = {
              step_index: s.step_index, name: s.name, label: s.label,
              status: s.status, detail: s.detail,
            }
          }
          return { ...prev, steps: next }
        })
      }

      const pollRun = async () => {
        if (settled || isStale()) return
        pollAttempts += 1
        try {
          const { data: run } = await agentsApi.getRun(runId)
          if (settled || isStale()) return
          consecutiveErrors = 0
          applySteps(run.steps)
          if (run.status === 'done' || run.status === 'failed') {
            finish({
              id: run.id, agent_type: run.agent_type, question: run.question,
              status: run.status, result_text: run.result_text, result: run.result,
              error_message: run.error_message, steps: run.steps,
            })
            return
          }
        } catch (err) {
          if (settled || isStale()) return
          const status = err?.response?.status
          if (status === 401) return fail('Your session expired. Please log in again and retry.')
          if (status === 404) return fail("Couldn't find this run on the server — it may have been deleted.")
          consecutiveErrors += 1
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return fail('Lost connection to the agent stream.')
        }
        if (pollAttempts >= MAX_POLL_ATTEMPTS) return fail('Lost connection to the agent stream.')
        pollTimer = setTimeout(pollRun, POLL_INTERVAL_MS)
      }

      const startFallback = () => {
        if (settled || isStale() || polling) return
        polling = true
        pollRun()
      }

      try {
        const token = getAccessToken()
        ws = new WebSocket(`${WS_BASE_URL}/ws/agents/${runId}?token=${encodeURIComponent(token || '')}`)
        wsRef.current = ws

        ws.onmessage = (event) => {
          if (settled || isStale()) return
          const msg = JSON.parse(event.data)
          if (msg.type === 'ping') return

          if (msg.type === 'step') {
            applySteps([{ step_index: msg.step_index, name: msg.name, label: msg.label, status: msg.status, detail: msg.detail }])
          } else if (msg.type === 'run_finished') {
            finish({
              id: runId, status: msg.status, result_text: msg.result_text,
              result: msg.result, error_message: msg.error,
            })
          }
        }

        // Handshake refused (e.g. something in front answering 404) or
        // dropped mid-run: the run still finishes server-side, so poll.
        ws.onerror = () => startFallback()
        ws.onclose = () => startFallback()
      } catch {
        startFallback()
      }
    })
  }, [closeSocket])

  const summarizeReference = useCallback(async (url, question, documentId) => {
    setIsOpen(true)
    setIsRunning(true)
    setError(null)
    setCurrentRun({ agent_type: 'summarize_reference', question: url, status: 'running', steps: [] })
    try {
      const { data } = await agentsApi.summarizeReference(url, question, documentId)
      setCurrentRun(data)
      setHistory((prev) => [data, ...prev].slice(0, 20))
      return data
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't summarize that link.")
      setCurrentRun((prev) => (prev ? { ...prev, status: 'failed' } : prev))
      throw err
    } finally {
      setIsRunning(false)
    }
  }, [])

  const reopenRun = useCallback((run) => {
    closeSocket()
    setCurrentRun(run)
    setError(null)
    setIsOpen(true)
  }, [closeSocket])

  const deleteCurrentRun = useCallback(async () => {
    closeSocket()
    if (currentRun?.id) {
      try {
        await agentsApi.deleteRun(currentRun.id)
      } catch {
        // even if the server delete fails, still clear it from view
      }
      setHistory((prev) => prev.filter((r) => r.id !== currentRun.id))
    }
    setCurrentRun(null)
    setError(null)
    setIsOpen(false)
  }, [currentRun, closeSocket])

  const closePanel = useCallback(() => setIsOpen(false), [])

  return (
    <AgentPanelContext.Provider
      value={{
        isOpen, isRunning, currentRun, error, history,
        runAgent, summarizeReference, reopenRun, closePanel, deleteCurrentRun, setIsOpen,
      }}
    >
      {children}
    </AgentPanelContext.Provider>
  )
}

export function useAgentPanel() {
  const ctx = useContext(AgentPanelContext)
  if (!ctx) throw new Error('useAgentPanel must be used within AgentPanelProvider')
  return ctx
}
