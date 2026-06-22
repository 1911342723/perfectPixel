export type SampleMethod = 'center' | 'median' | 'majority'
export type Status = 'connecting' | 'ready' | 'error'

export const SAMPLE_LABELS: Record<SampleMethod, string> = {
  center: '中心',
  median: '中位数',
  majority: '多数聚类'
}

export interface ViewProps {
  status: Status
  showToast: (m: string) => void
}

export const baseName = (p: string | null): string | null =>
  p ? p.split(/[\\/]/).pop() || p : null
