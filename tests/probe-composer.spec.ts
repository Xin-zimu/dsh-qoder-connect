import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderProbeControl, type QoderProbeControlProps } from '../src/client/QoderProbeControl.tsx'
import { en } from '../src/client/locales.ts'
import { QODER_PROBE_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'

/**
 * Composer-entry behaviour: the label is a static feature name (never a state
 * readout), the tooltip carries state and purpose, the confirmation is an in-page
 * bubble whose Cancel sends nothing (probing spends credit), and a detection is
 * authorized by `X-Qoder-Probe-Key` and never sent while a sweep runs.
 */

describe('Composer model probe', () => {
  let view: ReactTestRenderer | undefined
  let model: string
  let statusBody: Record<string, unknown>
  let state: ReturnType<QoderProbeControlProps['directory']['getSnapshot']>
  const listeners = new Set<() => void>()
  const request = vi.fn()
  /** Captured `focus` listeners, so a reconcile can be fired on demand. */
  let focusHandlers: (() => void)[] = []
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as QoderProbeControlProps['directory']
  const t: QoderProbeControlProps['t'] = (key, params = {}) =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  function select(nextProvider: string, nextModel: string) {
    model = nextModel
    state = { current: { provider: nextProvider, model: nextModel }, status: 'ready', groups: [], failures: [], error: null, routable: true }
    listeners.forEach(listener => listener())
  }

  /** The status document, with the probe section's fields overridable. */
  function probeStatus(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: ['qoder-thinking-pro', 'auto'], results: [], ...overrides },
    }
  }

  /** A completed detection answer, as the probe route returns it. */
  function probeAnswer(validation: string, efforts: string[] = []): unknown {
    return { state: 'ok', validation, efforts }
  }

  beforeEach(() => {
    probeStatus()
    select('qoder', 'qoder-thinking-pro')
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      // A successful detection writes a result the next status read reports: without
      // that the control would refresh and see the same candidate list again.
      const probed = JSON.parse(String(init.body)) as { model: string }
      const probe = statusBody['probe'] as Record<string, unknown>
      probe['candidates'] = (probe['candidates'] as string[]).filter(id => id !== probed.model)
      probe['results'] = [
        { id: probed.model, name: probed.model, validation: 'non-validating', efforts: [], probedAt: Date.now() },
        ...(probe['results'] as unknown[]),
      ]
      return { ok: true, json: async () => probeAnswer('non-validating') }
    })
    vi.stubGlobal('fetch', request)
    focusHandlers = []
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: (name: string, handler: () => void) => { if (name === 'focus') focusHandlers.push(handler) },
      removeEventListener: () => {},
    })
  })
  afterEach(() => {
    act(() => view?.unmount())
    view = undefined
    vi.unstubAllGlobals()
    listeners.clear()
  })

  async function mount() {
    await act(async () => { view = create(createElement(QoderProbeControl, { directory, t })) })
  }

  /** Unmount and mount again — the stand-in for a reload or a remount. */
  async function remount(): Promise<void> {
    await act(async () => { view?.unmount() })
    view = undefined
    await mount()
  }

  const posts = () => request.mock.calls.filter(([, init]) => init?.method === 'POST')
  const button = () => view!.root.findAllByType('button')
  const buttonLabels = () => button().map(node => node.children.join(''))
  const tooltips = () => view!.root.findAllByProps({ role: 'tooltip' })
  const notes = () => view!.root.findAllByProps({ role: 'status' })

  it('does not read status or show an entry for another provider', async () => {
    select('other', 'qoder-thinking-pro')
    await mount()
    expect(view?.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the Qoder status route of its own variant', async () => {
    await mount()
    expect(request.mock.calls[0]![0]).toBe(QODER_STATUS_PATH)
  })

  it('hides declared or non-candidate models', async () => {
    select('qoder', 'qoder-lite')
    await mount()
    expect(view?.toJSON()).toBeNull()
  })

  it('keeps the newer status when an older reconcile returns late', async () => {
    const oldStatus = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: [], results: [] },
    }
    let statusReads = 0
    let resolveFirst: ((value: Record<string, unknown>) => void) | undefined
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => probeAnswer('validating', ['low']) }
      }
      if (statusReads++ === 0) {
        const value = await new Promise<Record<string, unknown>>((resolve) => {
          resolveFirst = resolve
        })
        return { ok: true, json: async () => value }
      }
      return { ok: true, json: async () => statusBody }
    })

    await mount()
    await act(async () => {
      for (const handler of focusHandlers) handler()
    })
    expect(button()[0]!.props['aria-label']).toBe(en.probeTooltipIdle.replace('{model}', 'qoder-thinking-pro'))

    await act(async () => {
      resolveFirst!(oldStatus)
    })
    // The stale answer (no candidates, no results) must not resurrect the idle
    // tooltip nor hide the entry: the newer read wins.
    expect(button()[0]!.props['aria-label']).toBe(en.probeTooltipIdle.replace('{model}', 'qoder-thinking-pro'))
  })

  it('shows a static feature label that never carries state', async () => {
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    // A detection result must not turn the label into a state readout; the
    // entry stays visible for the detected model, label unchanged.
    probeStatus({
      candidates: [],
      results: [{ id: 'qoder-thinking-pro', name: 'Qoder Thinking Pro', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await act(async () => { listeners.forEach(listener => listener()) })
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    expect(JSON.stringify(view!.toJSON())).not.toContain('low / high')
  })

  it('explains the click in a tooltip on hover, not a native title', async () => {
    await mount()
    expect(tooltips()).toHaveLength(0)
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('qoder-thinking-pro')
    // The tooltip is the accessible description; no `title` attribute is used.
    expect(button()[0]!.props.title).toBeUndefined()
    expect(button()[0]!.props['aria-describedby']).toBeTruthy()
  })

  it('does not announce a result that predates this page', async () => {
    // The note is for "you just ran a detection"; a result already on record came from
    // elsewhere and is reported in the tooltip only.
    probeStatus({
      candidates: [],
      results: [{ id: 'qoder-thinking-pro', name: 'Qoder Thinking Pro', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await mount()
    expect(notes()).toHaveLength(0)
    // The result is still discoverable: the tooltip reports it on hover.
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('low / high')
  })

  it('does not re-announce after switching models away and back', async () => {
    probeStatus({
      candidates: ['qoder-thinking-pro', 'auto'],
      results: [{ id: 'qoder-thinking-pro', name: 'Qoder Thinking Pro', validation: 'validating', efforts: ['low'], probedAt: Date.now() }],
    })
    await mount()
    expect(notes()).toHaveLength(0)
    await act(async () => { select('qoder', 'auto') })
    await act(async () => { select('qoder', 'qoder-thinking-pro') })
    // Switching is not a reason to repeat something already on record.
    expect(notes()).toHaveLength(0)
  })

  it('opens an in-page confirmation instead of window.confirm', async () => {
    await mount()
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    await act(async () => { button()[0]!.props.onClick() })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(buttonLabels()).toEqual(expect.arrayContaining([en.cancel, en.probeConfirmAction]))
    // The bubble states the credit cost before anything is sent.
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeBubbleBody)
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const cancel = button().find(node => node.children.join('') === en.cancel)!
    await act(async () => { cancel.props.onClick() })
    expect(posts()).toHaveLength(0)
    // The bubble is gone again, leaving only the trigger.
    expect(button()).toHaveLength(1)
  })

  it('confirms the newly selected model and sends only that id, without automatic consent', async () => {
    await mount()
    await act(async () => { select('qoder', 'auto') })
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ action: 'probe', model: 'auto' })
    expect(posts()[0]![0]).toBe(QODER_PROBE_PATH)
    expect(posts()[0]![1].headers['X-Qoder-Probe-Key']).toBe('test-key')
  })

  it('sends nothing without the in-process probe key', async () => {
    // The key is what authorizes the write; no document carrying one means the
    // control cannot spend credit, whatever the user confirms.
    probeStatus({ consent: true })
    statusBody = { ...statusBody, probeKey: undefined }
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    expect(button()[0]!.props.disabled).toBe(true)
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(posts()).toHaveLength(0)
  })

  it('stays inert while a sweep is running', async () => {
    probeStatus({ running: true })
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    expect(button()[0]!.props.disabled).toBe(true)
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // One detection at a time: the running sweep already spends the credit.
    expect(posts()).toHaveLength(0)
  })

  it('blocks double clicks before the request finishes', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick(); detect.props.onClick() })
    expect(posts()).toHaveLength(1)
  })

  it('closes the confirmation once the request completes', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // The confirmation is gone — replaced by the outcome note, which is a
    // different bubble. Only Cancel/Detect disappear.
    expect(buttonLabels()).not.toContain(en.probeConfirmAction)
    expect(buttonLabels()).not.toContain(en.cancel)
  })

  it('announces the outcome of a detection this control started', async () => {
    // The self-initiated path still announces: the user just spent a request
    // and needs to know what came back.
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // The POST answer is reported by the note.
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })

  it('dismisses the note and never replays it after a remount', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    const dismiss = button().find(node => node.children.join('') === en.probeNoteDismiss)!
    await act(async () => { dismiss.props.onClick() })
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)

    // The outcome came from this control's own click, so there is nothing to
    // persist: a reload starts clean and a stored result is not news again.
    const probedAt = Date.now()
    probeStatus({
      candidates: [],
      results: [{ id: 'qoder-thinking-pro', name: 'Qoder Thinking Pro', validation: 'non-validating', efforts: [], probedAt }],
    })
    await remount()
    expect(notes()).toHaveLength(0)
  })

  it('announces a cached result even if its timestamp predates the click', async () => {
    probeStatus({ candidates: [], results: [{ id: 'qoder-thinking-pro', name: 'Qoder Thinking Pro',
      validation: 'validating', efforts: ['low', 'high'], probedAt: 1 }] })
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true, json: async () => init?.method === 'POST'
        ? probeAnswer('validating', ['low', 'high'])
        : statusBody,
    }))
    await act(async () => { button()[0]!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(JSON.stringify(view!.toJSON())).toContain('low / high')
  })

  it('shows completion without waiting for a hung credit/status refresh', async () => {
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Promise(() => {})
      return { ok: true, json: async () => probeAnswer('validating', ['high']) }
    })
    await act(async () => { button()[0]!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(button()[0]!.props['aria-busy']).toBe(false)
  })

  it('keeps a successful result when the following status request fails', async () => {
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') throw new Error('credit unavailable')
      return { ok: true, json: async () => probeAnswer('validating', ['high']) }
    })
    await act(async () => { button()[0]!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(button()[0]!.props['aria-label']).not.toBe(en.probeTooltipRetry)
  })

  it('reports a non-validating outcome instead of verified levels', async () => {
    // The stubbed POST answers `non-validating`.
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeNoteNotValidating)
    expect(JSON.stringify(view!.toJSON())).not.toContain(en.probeNoteVerified.split('{')[0]!)
  })

  it('still announces when a poll delivers a result mid-flight', async () => {
    // The 60s reconcile poll can land mid-flight; it must not consume the "I started this" flag.
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!

    // A poll landing mid-flight with another model's result: the same interference.
    statusBody['probe'] = {
      ...(statusBody['probe'] as Record<string, unknown>),
      results: [{ id: 'auto', name: 'auto', validation: 'validating', efforts: ['low'], probedAt: Date.now() }],
    }
    await act(async () => { detect.props.onClick() })

    // The user's own detection is still announced.
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })
})
