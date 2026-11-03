import * as ContextMenu from '@radix-ui/react-context-menu';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties, ReactNode } from 'react';
import { STATUS_META } from '../core/status';
import type { PanelCell } from '../core/types';
import { BADGE_H, CARD_H, CARD_W, metaLine } from './layout';

export type CardAction = 'select' | 'multi' | 'primary' | 'start' | 'open' | 'release';

export interface CardData extends Record<string, unknown> {
  cell: PanelCell;
  owner: string | null;
  bottleneck: boolean;
  blocks: number;
  selected: boolean;
  dim: boolean;
  onAct: (id: string, action: CardAction) => void;
}

export type CardNode = Node<CardData, 'cell'>;

const badge = (bg: string, fg: string): CSSProperties => ({
  background: bg,
  color: fg,
  borderRadius: 4,
  padding: '0 5px',
  lineHeight: '14px',
  fontSize: 10,
  fontWeight: 700,
  whiteSpace: 'nowrap',
});

function Item({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className='cursor-pointer rounded px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--surface-2)]'
    >
      {children}
    </ContextMenu.Item>
  );
}

/** 152x72 card. The badge row sits above it (BADGE_H) and never overlaps it. */
export function CellCard({ data }: NodeProps<CardNode>) {
  const { cell, owner, bottleneck, blocks, selected, dim, onAct } = data;
  const meta = STATUS_META[cell.status];
  const sha7 = (cell.sha.merged ?? cell.sha.tip ?? cell.sha.lock ?? '').slice(0, 7) || '–';
  const line = metaLine(cell);
  const canStart = cell.status === 'ready';
  const canOpen = cell.status === 'running' && owner !== null;
  const canRelease = cell.status === 'running' || cell.status === 'expired' || bottleneck;
  const handleTop = BADGE_H + CARD_H / 2;

  return (
    <ContextMenu.Root>
      <div style={{ width: CARD_W, opacity: dim ? 0.35 : 1 }}>
        <div className='flex items-end gap-1 overflow-hidden pb-1.5' style={{ height: BADGE_H }}>
          {canStart && (
            <button
              type='button'
              className='nodrag'
              style={{ ...badge(meta.color, '#10131A'), cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                onAct(cell.id, 'start');
              }}
            >
              START
            </button>
          )}
          {owner && (
            <span className='min-w-0 truncate' title={owner} style={badge('var(--surface-2)', 'var(--muted)')}>
              {owner}
            </span>
          )}
          {bottleneck && <span style={badge(STATUS_META.expired.color, '#10131A')}>BLOCKS {blocks}</span>}
        </div>

        <ContextMenu.Trigger asChild>
          <div className='relative' style={{ width: CARD_W, height: CARD_H }} onContextMenu={() => onAct(cell.id, 'select')}>
            {bottleneck && (
              <span
                aria-hidden
                className='pointer-events-none absolute rounded-[10px] border-[3px] motion-safe:animate-pulse'
                style={{ inset: -4, borderColor: STATUS_META.expired.color }}
              />
            )}
            <div
              role='button'
              tabIndex={-1}
              aria-pressed={selected}
              aria-label={`${cell.id}, ${meta.label}: ${cell.title}`}
              className='box-border flex h-full w-full cursor-pointer flex-col justify-between overflow-hidden rounded-lg border px-2 py-1 text-left'
              style={{
                background: 'var(--surface)',
                borderColor: meta.color,
                borderLeftWidth: 4,
                outline: selected ? '2px solid var(--accent, #5B9DFF)' : 'none',
                outlineOffset: bottleneck ? 5 : 2,
              }}
              onClick={(e) => onAct(cell.id, e.shiftKey ? 'multi' : 'select')}
              onDoubleClick={() => onAct(cell.id, 'primary')}
            >
              <div className='flex items-center justify-between gap-1'>
                <span className='mono text-[11px] font-semibold'>{cell.id}</span>
                <span
                  className='whitespace-nowrap rounded px-1 text-[9px] font-semibold'
                  style={{ color: meta.color, border: `1px solid ${meta.color}` }}
                >
                  {meta.icon} {meta.label}
                </span>
              </div>
              <div className='truncate text-[11px]' title={cell.title}>
                {cell.title}
              </div>
              <div className='mono text-[9px]' style={{ color: 'var(--muted)' }}>
                {sha7}
              </div>
              <div className='truncate text-[9px]' style={{ color: 'var(--muted)' }} title={line}>
                {line || '–'}
              </div>
            </div>
          </div>
        </ContextMenu.Trigger>
      </div>

      <Handle type='target' position={Position.Left} isConnectable={false} style={{ top: handleTop, opacity: 0 }} />
      <Handle type='source' position={Position.Right} isConnectable={false} style={{ top: handleTop, opacity: 0 }} />

      <ContextMenu.Portal>
        <ContextMenu.Content
          className='z-50 min-w-[170px] rounded-md border p-1 text-xs shadow-lg'
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <Item onSelect={() => onAct(cell.id, 'select')}>Select</Item>
          {canStart && <Item onSelect={() => onAct(cell.id, 'start')}>Start</Item>}
          {canOpen && <Item onSelect={() => onAct(cell.id, 'open')}>Open chat</Item>}
          {canRelease && <Item onSelect={() => onAct(cell.id, 'release')}>Release</Item>}
          <Item onSelect={() => void navigator.clipboard?.writeText(cell.id)}>Copy id</Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
