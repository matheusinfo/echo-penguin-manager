// Container lifecycle actions (start/stop/restart/pause/unpause/rm), each behind a confirm where it matters.
import { Play, Square, RotateCw, Pause, Trash } from 'lucide-react';
import { run, shq } from '../../api';
import { useAction, useApp } from '../../hooks';
import { Button } from '../../components/ui';

export type CAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'rm';

interface Target { name: string; state: string; project?: string }

const OK: Record<CAction, string> = {
  start: 'iniciado',
  stop: 'parado',
  restart: 'reiniciado',
  pause: 'pausado',
  unpause: 'retomado',
  rm: 'removido',
};

export function useContainerActions(onChanged: () => void) {
  const { confirm } = useApp();
  const { busy, act } = useAction();

  const doAction = async (c: Target, action: CAction) => {
    const compose = c.project ? `\n\nEle faz parte do projeto compose "${c.project}".` : '';
    if (action === 'stop') {
      const ok = await confirm({
        title: 'Parar contêiner',
        message: `Parar "${c.name}"?${compose}\n\nCom restart policy "unless-stopped" ele continua parado até ser iniciado de novo.`,
        confirmLabel: 'Parar',
      });
      if (!ok) return false;
    } else if (action === 'restart') {
      const ok = await confirm({ title: 'Reiniciar contêiner', message: `Reiniciar "${c.name}"?${compose}`, confirmLabel: 'Reiniciar' });
      if (!ok) return false;
    } else if (action === 'pause') {
      const ok = await confirm({
        title: 'Pausar contêiner',
        message: `Pausar (congelar) os processos de "${c.name}"? Ele continua ocupando memória.`,
        confirmLabel: 'Pausar',
      });
      if (!ok) return false;
    } else if (action === 'rm') {
      if (c.state === 'running' || c.state === 'paused' || c.state === 'restarting') return false;
      const ok = await confirm({
        title: 'Remover contêiner',
        message: `Remover o contêiner parado "${c.name}"? A camada gravável dele é apagada (volumes e bind mounts ficam).${
          c.project ? `\n\nO projeto "${c.project}" o recria em "docker compose up".` : '\n\nEste contêiner não pertence a um projeto compose: não há como recriá-lo automaticamente.'}`,
        confirmLabel: 'Remover',
        danger: true,
      });
      if (!ok) return false;
    }
    const timeout = action === 'stop' || action === 'restart' ? 90000 : 45000;
    const done = await act(`${c.name}:${action}`, () => run(`docker ${action} ${shq(c.name)}`, { timeout }), `${c.name} ${OK[action]}`);
    onChanged();
    return done;
  };

  return { busy, doAction };
}

/** Icon buttons for the lifecycle actions that make sense in the container's state. */
export function LifecycleButtons({ c, busy, onAction, labels = false }: {
  c: Target; busy: string | null; onAction: (a: CAction) => void; labels?: boolean;
}) {
  const running = c.state === 'running' || c.state === 'restarting';
  const paused = c.state === 'paused';
  const b = (a: CAction) => busy === `${c.name}:${a}`;
  const any = !!busy && busy.startsWith(`${c.name}:`);
  const L = (s: string) => (labels ? s : undefined);
  return (
    <>
      {!running && !paused && (
        <Button size="s" variant="ghost" icon={<Play size={14} />} title="Iniciar" busy={b('start')} disabled={any} onClick={() => onAction('start')}>{L('Iniciar')}</Button>
      )}
      {(running || paused) && (
        <Button size="s" variant="ghost" icon={<Square size={14} />} title="Parar" busy={b('stop')} disabled={any} onClick={() => onAction('stop')}>{L('Parar')}</Button>
      )}
      {(running || paused) && (
        <Button size="s" variant="ghost" icon={<RotateCw size={14} />} title="Reiniciar" busy={b('restart')} disabled={any} onClick={() => onAction('restart')}>{L('Reiniciar')}</Button>
      )}
      {running && (
        <Button size="s" variant="ghost" icon={<Pause size={14} />} title="Pausar" busy={b('pause')} disabled={any} onClick={() => onAction('pause')}>{L('Pausar')}</Button>
      )}
      {paused && (
        <Button size="s" variant="ghost" icon={<Play size={14} />} title="Retomar (unpause)" busy={b('unpause')} disabled={any} onClick={() => onAction('unpause')}>{L('Retomar')}</Button>
      )}
      {!running && !paused && (
        <Button size="s" variant="ghost" icon={<Trash size={14} />} title="Remover" busy={b('rm')} disabled={any} onClick={() => onAction('rm')}>{L('Remover')}</Button>
      )}
    </>
  );
}
