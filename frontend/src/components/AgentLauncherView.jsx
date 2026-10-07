import { useState } from 'react'
import { Sparkles, AlertCircle } from 'lucide-react'
import { useAgentPanel } from '../context/AgentPanelContext'
import { useDocuments } from '../context/DocumentsContext'
import DocumentPicker from './DocumentPicker'

const AGENT_INFO = {
  planner: {
    title: 'Planner Agent',
    desc: 'Ask anything — the planner classifies your intent and routes to the right tool (recommendations, timeline, gaps, citations, or general chat) automatically.',
    placeholder: 'e.g. "What should I read next on this topic?" — or leave blank and just pick a document',
    requiresDoc: false,
    multiDoc: false,
  },
  research: {
    title: 'Research Agent',
    desc: 'Combines your document(s) — select more than one to compare — with live arXiv + Semantic Scholar search for a substantive answer, links last.',
    placeholder: 'e.g. "How does this compare to recent transformer research?" — works with just a topic too',
    requiresDoc: false,
    multiDoc: true,
  },
  citation: {
    title: 'Citation Agent',
    desc: 'Answers with real page numbers and a confidence score, re-ranked for accuracy. Select multiple documents to get citations across all of them.',
    placeholder: 'e.g. "What does the document say about limitations?"',
    requiresDoc: true,
    multiDoc: true,
  },
  recommendation: {
    title: 'Recommendation Agent',
    desc: 'Searches Semantic Scholar and recommends papers/techniques worth exploring next.',
    placeholder: 'e.g. "transformer efficiency techniques" — or select a document and leave this blank',
    requiresDoc: false,
    multiDoc: false,
  },
  timeline: {
    title: 'Timeline Agent',
    desc: 'Builds a chronological timeline of how a topic evolved, based on dated papers found online.',
    placeholder: 'e.g. "attention mechanisms in NLP" — or select a document and leave this blank',
    requiresDoc: false,
    multiDoc: false,
  },
  innovation: {
    title: 'Innovation Agent',
    desc: 'Combines research gaps with recent trends to suggest novel, specific project ideas.',
    placeholder: 'e.g. "low-resource language modeling" — or select a document and leave this blank',
    requiresDoc: false,
    multiDoc: false,
  },
}

export default function AgentLauncherView({ agentType }) {
  const info = AGENT_INFO[agentType]
  const { runAgent } = useAgentPanel()
  const { selectedId } = useDocuments()
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedIds, setSelectedIds] = useState(selectedId ? [selectedId] : [])

  async function handleRun(e) {
    e.preventDefault()
    if (!question.trim() && selectedIds.length === 0) {
      setError('Enter a topic/question, select a document, or both.')
      return
    }
    if (info.requiresDoc && selectedIds.length === 0) {
      setError('This agent needs a document — select or upload one below.')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await runAgent(agentType, question.trim(), selectedIds)
      setQuestion('')
    } catch (err) {
      setError(
        err?.agentStreamFailure
          ? err.message
          : err.response?.data?.detail || 'The agent run failed.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <div className="glass-card p-6">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-teal/10">
          <Sparkles size={20} className="text-teal-bright" strokeWidth={1.75} />
        </div>
        <h1 className="font-display text-lg font-semibold text-ink">{info.title}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">{info.desc}</p>

        <form onSubmit={handleRun} className="mt-5 space-y-3">
          <DocumentPicker
            selectedIds={selectedIds}
            onChange={setSelectedIds}
            multiDoc={info.multiDoc}
            label={`Document${info.multiDoc ? '(s)' : ''} ${info.requiresDoc ? '(required)' : '(optional — or upload a new one)'}`}
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-muted">
              Topic or question {info.requiresDoc ? '' : '(optional if a document is selected)'}
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={info.placeholder}
              rows={3}
              className="input-field resize-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral-glow">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? 'Running agent...' : 'Run agent'}
          </button>
        </form>
      </div>
    </div>
  )
}