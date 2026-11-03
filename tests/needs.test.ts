import { describe, expect, it } from 'vitest'
import { needs } from '../src/lib/needs'

const combo = [
  { combo_sku: 'SPK03', component_sku: 'SPK01', qty: 3 },
  { combo_sku: 'BOX1', component_sku: 'SPK01', qty: 1 },
  { combo_sku: 'BOX1', component_sku: 'TPC01', qty: 2 },
]
const o = (stage: string, dispatch_date: string | null, lines: [string, number][]) => ({ stage, order_date: '2026-10-01', dispatch_date, order_lines: lines.map(([sku, qty]) => ({ sku, qty })) })

describe('needs', () => {
  it('breaks combos and packs of 3 into single packs', () => {
    const r = needs([o('planned', null, [['SPK03', 2], ['BOX1', 5]])], combo, '2026-11-03')
    expect(r).toEqual([
      { sku: 'SPK01', open: 11, sent7: 0, sent30: 0 }, // 2×3 + 5×1
      { sku: 'TPC01', open: 10, sent7: 0, sent30: 0 },
    ])
  })
  it('counts sent orders by dispatch date; cancelled ones never', () => {
    const r = needs([
      o('dispatched', '2026-11-03', [['TPC01', 4]]),
      o('delivered', '2026-10-27', [['TPC01', 1]]), // 8th day back: inside 30, outside 7
      o('dispatched', '2026-09-01', [['TPC01', 100]]),
      o('cancelled', null, [['TPC01', 50]]),
    ], combo, '2026-11-03')
    expect(r).toEqual([{ sku: 'TPC01', open: 0, sent7: 4, sent30: 5 }])
  })
})
