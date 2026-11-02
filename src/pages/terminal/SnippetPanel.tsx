// "Comandos rápidos": persisted snippets that can be inserted into / executed in the active terminal.
import { useState } from 'react';
import { Play, CornerDownLeft, Pencil, Trash2, Plus, RotateCcw, AlertTriangle, PanelRightClose } from 'lucide-react';
import { Button, SearchInput, Empty } from '../../components/ui';
import { Snippet } from './common';

export default function SnippetPanel({ snippets, canSend, onRun, onEdit, onDelete, onAdd, onRestore, onCollapse }: {
  snippets: Snippet[];
  canSend: boolean;
  onRun(s: Snippet, execute: boolean): void;
  onEdit(s: Snippet): void;
  onDelete(s: Snippet): void;
  onAdd(): void;
  onRestore(): void;
  onCollapse(): void;
}) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const list = q ? snippets.filter((s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q)) : snippets;

  return (
    <aside className="tp-snippets">
      <div className="tp-snippets-head">
        <strong>Comandos rápidos</strong>
        <div className="row">
          <Button size="s" variant="ghost" icon={<Plus size={14} />} title="Novo comando" onClick={onAdd} />
          <Button size="s" variant="ghost" icon={<RotateCcw size={14} />} title="Restaurar comandos padrão" onClick={onRestore} />
          <Button size="s" variant="ghost" icon={<PanelRightClose size={14} />} title="Recolher painel" onClick={onCollapse} />
        </div>
      </div>
      <div className="tp-snippets-filter">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filtrar comandos…" />
      </div>
      <div className="tp-snippets-list">
        {list.length === 0 && <Empty>{q ? 'Nenhum comando encontrado' : 'Nenhum comando salvo'}</Empty>}
        {list.map((s) => (
          <div key={s.id} className="tp-snippet" title={s.command}>
            <button className="tp-snippet-main" disabled={!canSend} onClick={() => onRun(s, true)} title={`Executar: ${s.command}`}>
              <span className="tp-snippet-name">
                {s.danger && <AlertTriangle size={12} className="tp-danger-icon" />}
                <span className="ellipsis">{s.name}</span>
              </span>
              <code className="tp-snippet-cmd ellipsis">{s.command}</code>
            </button>
            <div className="tp-snippet-actions">
              <Button size="s" variant="ghost" disabled={!canSend} icon={<Play size={13} />} title="Executar (envia com Enter)" onClick={() => onRun(s, true)} />
              <Button size="s" variant="ghost" disabled={!canSend} icon={<CornerDownLeft size={13} />} title="Inserir (sem Enter)" onClick={() => onRun(s, false)} />
              <Button size="s" variant="ghost" icon={<Pencil size={13} />} title="Editar" onClick={() => onEdit(s)} />
              <Button size="s" variant="ghost" icon={<Trash2 size={13} />} title="Excluir" onClick={() => onDelete(s)} />
            </div>
          </div>
        ))}
      </div>
      {!canSend && <div className="tp-snippets-foot muted small">Abra uma sessão para enviar comandos.</div>}
    </aside>
  );
}
