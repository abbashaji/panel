import { Icon } from '../core/Icon';
import type { PanelCell } from '../core/types';
import { cellsLabel } from './layout';

export interface BannerParts {
  /** bold part: id and title */
  head: string;
  tail: string;
}

/** '<id> <title> is holding up N cells. Its lease expired M min ago (attempt a of b).' split into the bold head and the rest. */
export function bannerParts(cell: PanelCell, blocks: number): BannerParts {
  const mins = cell.lease?.expiredMinutesAgo ?? 0;
  const attempt = Math.max(1, cell.attempts);
  return {
    head: `${cell.id} ${cell.title}`,
    tail: ` is holding up ${cellsLabel(blocks)}. Its lease expired ${mins} min ago (attempt ${attempt} of ${cell.maxAttempts}).`,
  };
}

export function bannerText(cell: PanelCell, blocks: number): string {
  const p = bannerParts(cell, blocks);
  return p.head + p.tail;
}

/** The banner shows only when the bottleneck cell exists and its lease expired. */
export function showBanner(cell: PanelCell | null | undefined): cell is PanelCell {
  return !!cell && cell.status === 'expired';
}

export function Banner({ cell, blocks, onRelease }: { cell: PanelCell; blocks: number; onRelease: () => void }) {
  const { head, tail } = bannerParts(cell, blocks);
  return (
    <div
      role='status'
      className='flex shrink-0 items-center gap-2'
      style={{
        margin: '12px 16px 0',
        height: 44,
        padding: '0 8px 0 14px',
        borderRadius: 10,
        background: 'var(--danger-bg)',
        border: '1px solid var(--danger-border)',
        color: 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <Icon name='warning' size={16} color='var(--danger)' />
      <span className='min-w-0 flex-1 truncate' title={head + tail}>
        <strong style={{ fontWeight: 700 }}>{head}</strong>
        {tail}
      </span>
      <button
        type='button'
        onClick={onRelease}
        className='shrink-0'
        style={{ height: 32, padding: '0 14px', borderRadius: 8, background: 'var(--danger)', color: '#1A0B09', fontSize: 12.5, fontWeight: 700 }}
      >
        Release now
      </button>
    </div>
  );
}
