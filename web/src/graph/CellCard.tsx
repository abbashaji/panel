import * as ContextMenu from '@radix-ui/react-context-menu';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, StatusIcon } from '../core/Icon';
import { STATUS_META } from '../core/status';
import type { PanelCell } from '../core/types';
import { BADGE_H, CARD_H, CARD_W, badgeRules, metaLine, shaLabel } from './layout';

export type CardAction = 'select' | 'multi' | 'primary' | 'start' | 'open' | 'release';

export interface CardData extends Record<string, unknown> {
  cell: PanelCell;
  owner: string | null;
  /** the owner is you: the chip offers Open chat */
  mine: boolean;
  bottleneck: boolean;
  blocks: number;
  selected: boolean;
  onAct: (id: string, action: CardAction) => void;
}

export type CardNode = Node<CardData, 'cell'>;

const badge = (bg: string, fg: string): CSSProperties => ({
  background: bg,
  color: fg,
  borderRadius: 8,
  padding: '3px 8px',
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
  const { cell, owner, mine, bottleneck, blocks, selected, onAct } = data;
  const meta = STATUS_META[cell.status];
  const rules = badgeRules(cell, owner, mine, bottleneck, blocks);
  const sha7 = shaLabel(cell);
  const line = metaLine(cell);
  const canStart = rules.start;
  const canOpen = rules.owner?.clickable === true;
  const canRelease = cell.status === 'running' || cell.status === 'expired' || bottleneck;
  const handleTop = BADGE_H + CARD_H / 2;

  return (
    <ContextMenu.Root>
      <div style={{ width: CARD_W }}>
        <div className='flex items-end justify-between gap-1 overflow-hidden pb-0.5' style={{ height: BADGE_H }}>
          <div className='flex min-w-0 items-end gap-1'>
          {canStart && (
            <button
              type='button'
              className='nodrag'
              style={{ ...badge(meta.color, '#261A00'), letterSpacing: '.03em', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                onAct(cell.id, 'start');
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span className='inline-flex items-center gap-1'>
                <Icon name='play' size={9} />
                START
              </span>
            </button>
          )}
          {rules.owner &&
            (rules.owner.clickable ? (
              <button
                type='button'
                className='nodrag min-w-0 truncate'
                title={rules.owner.label}
                style={{ ...badge('var(--nav-active)', '#DDE6FF'), padding: '2px 8px', border: '1px solid #4A5F94', cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onAct(cell.id, 'open');
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {rules.owner.label}
              </button>
            ) : (
              <span
                className='min-w-0 truncate'
                title={rules.owner.label}
                style={{ ...badge('var(--surface-2)', 'var(--muted)'), padding: '2px 8px', border: '1px solid var(--raised-border)' }}
              >
                {rules.owner.label}
              </span>
            ))}
          </div>
          {rules.blocks !== null && (
            <span className='shrink-0' style={badge(STATUS_META.expired.color, '#1A0B09')}>
              BLOCKS {rules.blocks}
            </span>
          )}
        </div>

        <ContextMenu.Trigger asChild>
          <div className='relative' style={{ width: CARD_W, height: CARD_H }} onContextMenu={() => onAct(cell.id, 'select')}>
            <div
              role='button'
              tabIndex={-1}
              aria-pressed={selected}
              aria-label={`${cell.id}, ${meta.label}: ${cell.title}`}
              className='relative box-border flex h-full w-full cursor-pointer flex-col justify-between overflow-hidden border text-left'
              style={{
                background: 'var(--card)',
                borderColor: `${meta.color}88`,
                borderRadius: 12,
                padding: '8px 11px',
                outline: selected ? '2px solid var(--text)' : 'none',
                outlineOffset: 2,
                boxShadow: bottleneck ? '0 0 0 6px rgba(255,107,94,.28)' : undefined,
              }}
            >
              <span aria-hidden className='pointer-events-none absolute inset-0' style={{ background: meta.color, opacity: 0.1, borderRadius: 11 }} />
              <div className='relative flex items-center justify-between gap-1'>
                <span className='mono shrink-0' style={{ color: meta.color, fontSize: 11, fontWeight: 600 }}>
                  {cell.id}
                </span>
                <span className='inline-flex min-w-0 items-center gap-1 whitespace-nowrap' style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>
                  <StatusIcon status={cell.status} size={12} />
                  <span className='truncate'>{meta.label}</span>
                </span>
              </div>
              <div className='relative truncate' style={{ fontSize: 13, fontWeight: 600 }} title={cell.title}>
                {cell.title}
              </div>
              <div className='relative flex items-center justify-between gap-1' style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--muted)' }}>
                <span className='mono shrink-0'>{sha7}</span>
                <span className='truncate' title={line}>
                  {line}
                </span>
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
