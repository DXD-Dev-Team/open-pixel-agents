import { useState } from 'react'

export interface BrowserQuestion { question: string; header: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }
export function BrowserQuestionForm({ questions, pending, onSave, onCancel }: { questions: BrowserQuestion[]; pending: boolean; onSave: (answers: string[][]) => void; onCancel: () => void }) {
  const [choices, setChoices] = useState<Record<number, string[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const answers = questions.map((_, index) => [...(choices[index] ?? []), ...(custom[index]?.trim() ? [custom[index].trim()] : [])])
  return <form className="office-browser-account-form" aria-label="Answer agent questions" onSubmit={event => { event.preventDefault(); if (answers.every(answer => answer.length)) onSave(answers) }}>
    {questions.map((question, index) => <fieldset key={index}><legend>{question.header || `Question ${index + 1}`}</legend><p>{question.question}</p>{question.options.map(option => <label className="office-question-option" key={option.label}><input type={question.multiple ? 'checkbox' : 'radio'} name={`office-question-${index}`} checked={choices[index]?.includes(option.label) ?? false} disabled={pending} onChange={event => { setCustom(current => ({ ...current, [index]: '' })); setChoices(current => ({ ...current, [index]: question.multiple ? event.target.checked ? [...(current[index] ?? []), option.label] : (current[index] ?? []).filter(item => item !== option.label) : [option.label] })) }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}{(question.custom || !question.options.length) && <label>Custom answer<textarea aria-label={`Answer ${question.header || index + 1}`} rows={2} maxLength={2000} value={custom[index] ?? ''} disabled={pending} onChange={event => { if (!question.multiple) setChoices(current => ({ ...current, [index]: [] })); setCustom(current => ({ ...current, [index]: event.target.value })) }} /></label>}</fieldset>)}
    <div className="office-browser-actions"><button type="submit" disabled={pending || answers.some(answer => !answer.length)}>Send answers</button><button type="button" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>
}
