// Confirmed device actions shared by the settings tabs and the "Alarme & Tela" page.
import { useCallback } from 'react';
import { run } from '../../api';
import { useAction, useApp } from '../../hooks';
import { FIREWALL_LOG } from './lib';

/** Detached so the exec returns before the connection goes. */
export const REBOOT_CMD = `setsid sh -c 'sleep 1; sync; reboot' >/dev/null 2>&1 </dev/null &`;
export const BOOTLOADER_CMD = `setsid rebootto bootloader >/dev/null 2>&1 </dev/null &`;
/** `penguin firewall`, keeping firewall.log current as `penguin ssh` does. */
export const FIREWALL_CMD = `penguin firewall > ${FIREWALL_LOG} 2>&1; rc=$?; cat ${FIREWALL_LOG}; exit $rc`;

export function usePenguinActions(after?: () => void) {
  const { confirm, toast } = useApp();
  const { busy, act } = useAction();

  const restartSupervisor = useCallback(async (skipConfirm = false) => {
    if (!skipConfirm && !(await confirm({
      title: 'Reiniciar o supervisor',
      message: 'Executa "penguin restart": o supervisor (techo5) é encerrado e o init o inicia de novo, relendo as configurações.\n\nO dockerd e os containers continuam rodando. Leva poucos segundos.',
      confirmLabel: 'Reiniciar supervisor',
    }))) return false;
    const ok = await act('restart', () => run('penguin restart'), 'Supervisor reiniciando (o init o inicia de novo)');
    after?.();
    return ok;
  }, [act, confirm, after]);

  const applyFirewall = useCallback(async (skipConfirm = false) => {
    if (!skipConfirm && !(await confirm({
      title: 'Aplicar firewall',
      message: 'Executa "penguin firewall": as regras do Wi-Fi são refeitas com LAN_PORTS, DOCKER_LAN, SSH e SSH_ALLOW atuais.\n\nConexões já estabelecidas (como esta) continuam.',
      confirmLabel: 'Aplicar',
    }))) return false;
    let out = '';
    const ok = await act('firewall', async () => { out = await run(FIREWALL_CMD); });
    if (ok) toast(out.trim().split('\n').filter((l) => /iptables-legacy:|DOCKER-USER/.test(l)).join('\n') || 'Firewall aplicado', 'ok');
    after?.();
    return ok;
  }, [act, confirm, toast, after]);

  const rebootEcho = useCallback(async (reason?: string) => {
    if (!(await confirm({
      title: 'Reiniciar o Echo',
      message: `${reason ? reason + '\n\n' : ''}O Echo reinicia agora (leva cerca de 1–2 minutos). A conexão SSH cai; o Echo Manager tenta reconectar sozinho quando o SSH voltar.\n\nContainers com política de reinício voltam sozinhos. Um alarme ou timer que estiver tocando na tela é interrompido.`,
      confirmLabel: 'Reiniciar agora',
      danger: true,
    }))) return false;
    return act('reboot', () => run(REBOOT_CMD), 'Reiniciando o Echo… o app reconecta quando ele voltar');
  }, [act, confirm]);

  return { busy, act, restartSupervisor, applyFirewall, rebootEcho };
}
