import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const onSnapshotMock = vi.fn(() => () => {})
const queryMock = vi.fn((...args) => ({ kind: 'query', args }))
const collectionMock = vi.fn((...args) => ({ kind: 'collection', args }))
const whereMock = vi.fn((...args) => ({ kind: 'where', args }))
const inOpMock = vi.fn((...args) => ({ kind: 'in', args }))

vi.mock('firebase/firestore', () => ({
  collection: (...a) => collectionMock(...a),
  query: (...a) => queryMock(...a),
  where: (...a) => whereMock(...a),
  in: (...a) => inOpMock(...a),
  onSnapshot: (...a) => onSnapshotMock(...a),
}))

vi.mock('../lib/firebase', () => ({ db: { _mock: true } }))

import useQueueStates from '../hooks/useQueueStates'

function snap(docs) {
  return { docs: docs.map((d) => ({ data: () => d.data, id: d.id })) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useQueueStates', () => {
  it('subscribes to the queue collection for the page\'s distinct tracking numbers', () => {
    onSnapshotMock.mockImplementationOnce((q, cb) => { cb(snap([])); return () => {} })
    const { result } = renderHook(() => useQueueStates('acme', ['T1', 'T1', 'T2']))
    expect(collectionMock).toHaveBeenCalledWith(expect.anything(), 'organizations', 'acme', 'settings', 'textMessaging', 'queue')
    expect(onSnapshotMock).toHaveBeenCalled()
    expect(result.current).toEqual({})
  })

  it('chunks the in-query at 30 values when the page has more than 30 tracking numbers', () => {
    const many = Array.from({ length: 65 }, (_, i) => 'T' + i)
    onSnapshotMock.mockImplementation((q, cb) => { cb(snap([])); return () => {} })
    renderHook(() => useQueueStates('acme', many))
    const inCalls = whereMock.mock.calls.filter((c) => c[2] && c[2].kind === 'in')
    expect(inCalls.length).toBeGreaterThan(1)
    for (const c of inCalls) {
      const values = c[2].args[0]
      expect(values.length).toBeLessThanOrEqual(30)
    }
  })

  it('maps queue statuses to the operator vocabulary', () => {
    onSnapshotMock.mockImplementationOnce((q, cb) => {
      cb(snap([
        { id: 'T1__delivered', data: { status: 'pending' } },
        { id: 'T2__delivered', data: { status: 'sending' } },
        { id: 'T3__delivered', data: { status: 'complete' } },
        { id: 'T4__delivered', data: { status: 'failed' } },
        { id: 'T5__delivered', data: { status: 'dead' } },
      ]))
      return () => {}
    })
    const { result } = renderHook(() => useQueueStates('acme', ['T1', 'T2', 'T3', 'T4', 'T5']))
    expect(result.current).toEqual({
      T1: 'Queued',
      T2: 'Sending',
      T3: 'Sent',
      T4: 'Retrying',
      T5: 'Not sent',
    })
  })

  it('shows the most recent queue doc when a tracking number has several template keys', () => {
    onSnapshotMock.mockImplementationOnce((q, cb) => {
      cb(snap([
        { id: 'T1__delivered', data: { status: 'complete', updatedAt: 100 } },
        { id: 'T1__shipped', data: { status: 'pending', updatedAt: 200 } },
      ]))
      return () => {}
    })
    const { result } = renderHook(() => useQueueStates('acme', ['T1']))
    expect(result.current).toEqual({ T1: 'Queued' })
  })
})
