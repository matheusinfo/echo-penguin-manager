// "Alarme & Tela" → Voz: the espeak-ng voice (SPEAK_VOICE), speaking after an alarm (SPEAK_ALARM) and
// a test that says what the Echo says after an alarm. echo-penguin v0.3.0+. With v0.3.1+, the
// alarm's greeting can use Piper, a natural offline voice (SPEAK_ENGINE, PIPER_VOICE): it takes about
// 40 s to render on the Echo, so penguin-ui prepares it ahead; the tap on the clock stays espeak.
// After v0.3.1 Piper is the only voice (PiperVoiceCard): the tap on the clock is said from clips the
// Echo renders ahead, in the same voice; SPEAK_ENGINE and SPEAK_VOICE are gone.
import { useEffect, useState } from 'react';
import { Info, MessageSquare, Play, Sparkles, Speech, TriangleAlert } from 'lucide-react';
import { errMsg, run } from '../../api';
import { useApp } from '../../hooks';
import { Button, Card, Switch } from '../../components/ui';
import { COMMON_VOICES, sayClockCmd, sayCmd, sayGreetingCmd, sayTextError, speaksPortuguese, validVoice, voiceLabel } from '../weather';
import { NEEDS_V031, validPiperVoice } from '../features';
import { Custom, DevState, NeedsVersion, SetLive, SettingSeg } from './common';

/** The image's Piper voice. */
const DEFAULT_PIPER_VOICE = 'pt_BR-faber-medium';
/** Piper takes ~40 s on the Echo's CPU before the first sound; room for a slow run. */
const PIPER_TIMEOUT_MS = 150000;

export function voiceSupported(data: DevState): boolean {
  return data.features.say && ('SPEAK_VOICE' in data.defaults || data.features.clips);
}

/** The unit has Piper and knows its settings (echo-penguin v0.3.1+). */
export function piperSupported(data: DevState): boolean {
  return data.features.piper && 'SPEAK_ENGINE' in data.defaults;
}

/** Seconds since `on` became true (0 while false): a running counter for slow commands. */
function useElapsed(on: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    setS(0);
    if (!on) return;
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [on]);
  return s;
}

interface VoiceProps { data: DevState; busy: string | null; setLive: SetLive }

export function VoiceCard(props: VoiceProps) {
  return props.data.features.clips ? <PiperVoiceCard {...props} /> : <EngineVoiceCard {...props} />;
}

/** After v0.3.1: one voice, Piper's, for the alarm's greeting and the tap on the clock. */
function PiperVoiceCard({ data, busy, setLive }: VoiceProps) {
  const { toast } = useApp();
  const [spoken, setSpoken] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [speaking, setSpeaking] = useState<string | null>(null);
  const elapsed = useElapsed(speaking === 'alarm' || speaking === 'text');

  const speakAlarm = (data.effective.SPEAK_ALARM ?? data.defaults.SPEAK_ALARM ?? '1') === '1';
  const voice = data.effective.PIPER_VOICE || data.defaults.PIPER_VOICE || DEFAULT_PIPER_VOICE;
  const list = data.piperVoices;
  const missing = !data.features.piper || !list.includes(voice);
  const textErr = text ? sayTextError(text) : null;

  const say = async (key: string, cmd: string, show: boolean, timeout = 90000) => {
    setSpeaking(key);
    if (show) setSpoken(null);
    try {
      const out = (await run(cmd, { timeout })).trim();
      if (show) setSpoken(out.split('\n')[0] || null);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSpeaking(null);
    }
  };

  return (
    <Card title="Voz" icon={<Speech size={16} />}>
      <div className="col gap-m">
        {!data.features.piper && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>O Piper não está instalado neste Echo: ele não consegue falar.</div></div>
        )}
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Voz <span className="mono muted small">PIPER_VOICE</span><Custom data={data} k="PIPER_VOICE" /></div>
            <div className="dv-opt-desc">
              A voz natural (Piper) do despertador e do toque no relógio. Fala em {speaksPortuguese(voice.toLowerCase()) ? 'português' : 'inglês'}: as
              vozes pt* falam português, as outras inglês. As vozes ficam em /usr/share/piper/voices e as suas em /data/penguin/voices
              (arquivos .onnx e .onnx.json). Ao trocar de voz, o Echo leva uns 10 min para preparar as frases do relógio.
            </div>
          </div>
          <select className="input" value={voice} disabled={busy === 'PIPER_VOICE'} aria-label="voz"
            onChange={(e) => validPiperVoice(e.target.value) && setLive('PIPER_VOICE', e.target.value, `Voz: ${e.target.value}`)}>
            {!list.includes(voice) && <option value={voice}>{voice} (não encontrada)</option>}
            {list.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {data.features.piper && missing && (
          <div className="dv-note warn">
            <TriangleAlert size={15} />
            <div>{list.length ? <>A voz <span className="mono">{voice}</span> não está no Echo.</> : 'Nenhuma voz do Piper encontrada no Echo.'} Sem ela, o Echo não fala.</div>
          </div>
        )}
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Falar depois do alarme <span className="mono muted small">SPEAK_ALARM</span><Custom data={data} k="SPEAK_ALARM" /></div>
            <div className="dv-opt-desc">Ao parar um alarme, o Echo diz bom dia, a hora em que o alarme tocou e o clima (fala preparada uns 10 min antes). Tocar no relógio grande da tela inicial também fala, na hora, com a mesma voz.</div>
          </div>
          <Switch checked={speakAlarm} disabled={busy === 'SPEAK_ALARM'}
            onChange={(v) => setLive('SPEAK_ALARM', v ? '1' : '0', v ? 'O Echo fala depois do alarme' : 'O Echo não fala depois do alarme')} />
        </div>
        <div className="col gap-s">
          <div className="row gap-s wrap">
            <Button variant="primary" icon={<Play size={14} />} busy={speaking === 'clock'} disabled={speaking != null || missing}
              onClick={() => say('clock', sayClockCmd(), true)}
              title={'penguin-sound say --ready "$(penguin-weather speech --clips)"'}>Testar voz</Button>
            <span className="muted small">o que o Echo diz ao tocar no relógio, na hora</span>
          </div>
          <div className="row gap-s wrap">
            <Button icon={<Sparkles size={14} />} busy={speaking === 'alarm'} disabled={speaking != null || missing}
              onClick={() => say('alarm', sayGreetingCmd('piper', voice), true, PIPER_TIMEOUT_MS)}
              title={`penguin-sound say -v ${voice} "$(penguin-weather speech)"`}>Testar fala completa</Button>
            <span className="muted small">
              {speaking === 'alarm' ? `Gerando a fala com o Piper (cerca de 40 s)… ${elapsed} s` : 'a frase inteira, gerada agora (cerca de 40 s)'}
            </span>
          </div>
          {spoken && speaking == null && <div className="dv-spoken">“{spoken}”</div>}
        </div>
        <div className="col gap-s">
          <span className="field-label">Falar um texto</span>
          <form className="row gap-s" onSubmit={(e) => { e.preventDefault(); if (!sayTextError(text)) say('text', sayCmd(text), false, PIPER_TIMEOUT_MS); }}>
            <input className="input grow" value={text} maxLength={300} placeholder={speaksPortuguese(voice.toLowerCase()) ? 'ex.: O café está pronto' : 'ex.: Coffee is ready'}
              onChange={(e) => setText(e.target.value)} />
            <Button type="submit" icon={<MessageSquare size={14} />} busy={speaking === 'text'} disabled={speaking != null || missing || !text.trim() || !!textErr}>Falar</Button>
          </form>
          {textErr && <span className="st-err" style={{ color: 'var(--bad)', fontSize: 12 }}>{textErr}</span>}
          <span className="field-hint">
            {speaking === 'text' ? `Gerando a fala com o Piper… ${elapsed} s` : 'Com a voz do Piper, no volume atual: uns 20 a 40 s até falar (um texto repetido sai na hora).'}{' '}
            Se algo já estiver tocando, a fala é ignorada (penguin-sound toca um som por vez).
          </span>
        </div>
      </div>
    </Card>
  );
}

/** Up to v0.3.1: espeak-ng's voice, and with v0.3.1 Piper for the alarm's greeting (SPEAK_ENGINE). */
function EngineVoiceCard({ data, busy, setLive }: VoiceProps) {
  const { toast } = useApp();
  const [spoken, setSpoken] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [natural, setNatural] = useState<string | null>(null);
  const elapsed = useElapsed(speaking === 'piper');

  if (!voiceSupported(data)) {
    return (
      <Card title="Voz" icon={<Speech size={16} />}>
        <NeedsVersion data={data} what="Fala da hora e do clima" />
      </Card>
    );
  }

  const voice = data.effective.SPEAK_VOICE || data.defaults.SPEAK_VOICE || 'en';
  const speakAlarm = (data.effective.SPEAK_ALARM ?? data.defaults.SPEAK_ALARM ?? '1') === '1';
  // The Echo's own list when espeak-ng can tell it, else the usual ones; the current voice always.
  const list = data.voices.length ? data.voices : COMMON_VOICES;
  const preferred = COMMON_VOICES.filter((v) => list.includes(v));
  const others = list.filter((v) => !preferred.includes(v));
  const textErr = text ? sayTextError(text) : null;
  const hasPiper = piperSupported(data);
  // Units with Piper get the engine spelled out (`-e espeak`); older penguin-sound has no -e.
  const espeakOpt = hasPiper ? 'espeak' as const : undefined;
  const engine = hasPiper ? (data.effective.SPEAK_ENGINE || data.defaults.SPEAK_ENGINE || 'espeak') : 'espeak';
  const piperVoice = data.effective.PIPER_VOICE || data.defaults.PIPER_VOICE || DEFAULT_PIPER_VOICE;
  const piperList = data.piperVoices;
  const piperMissing = !piperList.includes(piperVoice);

  const say = async (key: string, cmd: string, show: ((line: string | null) => void) | null, timeout = 90000) => {
    setSpeaking(key);
    try {
      const out = (await run(cmd, { timeout })).trim();
      show?.(out.split('\n')[0] || null);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSpeaking(null);
    }
  };

  return (
    <Card title="Voz" icon={<Speech size={16} />}>
      <div className="col gap-m">
        {!data.features.espeak && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>O espeak-ng não está instalado neste Echo: ele não consegue falar.</div></div>
        )}
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">{hasPiper ? 'Voz do espeak' : 'Voz'} <span className="mono muted small">SPEAK_VOICE</span><Custom data={data} k="SPEAK_VOICE" /></div>
            <div className="dv-opt-desc">Fala em {speaksPortuguese(voice) ? 'português' : 'inglês'}: as vozes pt* falam português, as outras inglês.</div>
          </div>
          <select className="input" value={voice} disabled={busy === 'SPEAK_VOICE'} aria-label="voz"
            onChange={(e) => validVoice(e.target.value) && setLive('SPEAK_VOICE', e.target.value, `Voz: ${voiceLabel(e.target.value)}`)}>
            {!list.includes(voice) && <option value={voice}>{voiceLabel(voice)}</option>}
            {preferred.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
            {others.length > 0 && (
              <optgroup label="Outras vozes do espeak-ng">
                {others.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Falar depois do alarme <span className="mono muted small">SPEAK_ALARM</span><Custom data={data} k="SPEAK_ALARM" /></div>
            <div className="dv-opt-desc">Ao parar um alarme, o Echo diz bom dia, a hora e o clima. Tocar no relógio grande da tela inicial também fala.</div>
          </div>
          <Switch checked={speakAlarm} disabled={busy === 'SPEAK_ALARM'}
            onChange={(v) => setLive('SPEAK_ALARM', v ? '1' : '0', v ? 'O Echo fala depois do alarme' : 'O Echo não fala depois do alarme')} />
        </div>
        <div className="col gap-s">
          <div className="row gap-s wrap">
            <Button variant="primary" icon={<Play size={14} />} busy={speaking === 'greet'} disabled={speaking != null}
              onClick={() => say('greet', sayGreetingCmd(espeakOpt), setSpoken)}
              title={`penguin-sound say ${hasPiper ? '-e espeak ' : ''}"$(penguin-weather speech)"`}>Testar voz</Button>
            <span className="muted small">{hasPiper ? 'com o espeak: o que o Echo diz ao tocar no relógio' : 'o que o Echo diz depois do alarme'}</span>
          </div>
          {spoken && <div className="dv-spoken">“{spoken}”</div>}
        </div>
        {hasPiper ? (
          <>
            <div className="dv-opt">
              <div>
                <div className="dv-opt-title">Voz do despertador <span className="mono muted small">SPEAK_ENGINE</span><Custom data={data} k="SPEAK_ENGINE" /></div>
                <div className="dv-opt-desc">
                  Com o Piper (voz natural), o despertador usa a fala preparada uns 10 min antes do alarme (ela leva uns 40 s
                  para ser gerada); tocar no relógio usa sempre o espeak, na hora.
                </div>
              </div>
              <SettingSeg data={data} k="SPEAK_ENGINE" busy={busy} setLive={setLive}
                okMsg={(v) => (v === 'piper' ? 'Despertador: voz natural (Piper)' : 'Despertador: voz do espeak')}
                options={[
                  { value: 'espeak', label: 'espeak', title: 'robótica, instantânea' },
                  { value: 'piper', label: 'Piper (natural)', title: 'voz neural offline, preparada antes do alarme' },
                ]} />
            </div>
            {engine === 'piper' && (
              <>
                <div className="dv-opt">
                  <div>
                    <div className="dv-opt-title">Voz natural <span className="mono muted small">PIPER_VOICE</span><Custom data={data} k="PIPER_VOICE" /></div>
                    <div className="dv-opt-desc">As vozes do Piper no Echo: /usr/share/piper/voices e as suas em /data/penguin/voices (arquivos .onnx e .onnx.json).</div>
                  </div>
                  <select className="input" value={piperVoice} disabled={busy === 'PIPER_VOICE'} aria-label="voz natural"
                    onChange={(e) => validPiperVoice(e.target.value) && setLive('PIPER_VOICE', e.target.value, `Voz natural: ${e.target.value}`)}>
                    {piperMissing && <option value={piperVoice}>{piperVoice} (não encontrada)</option>}
                    {piperList.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                {piperMissing && (
                  <div className="dv-note warn">
                    <TriangleAlert size={15} />
                    <div>
                      {piperList.length ? <>A voz <span className="mono">{piperVoice}</span> não está no Echo.</> : 'Nenhuma voz do Piper encontrada no Echo.'}{' '}
                      Sem ela, o despertador não consegue usar a voz natural.
                    </div>
                  </div>
                )}
                <div className="col gap-s">
                  <div className="row gap-s wrap">
                    <Button icon={<Sparkles size={14} />} busy={speaking === 'piper'} disabled={speaking != null || piperMissing}
                      onClick={() => { setNatural(null); say('piper', sayGreetingCmd('piper', piperVoice), setNatural, PIPER_TIMEOUT_MS); }}
                      title={`penguin-sound say -e piper -v ${piperVoice} "$(penguin-weather speech)"`}>Testar voz natural</Button>
                    <span className="muted small">
                      {speaking === 'piper' ? `Gerando a fala com o Piper (cerca de 40 s)… ${elapsed} s` : 'o que o despertador diz, com o Piper'}
                    </span>
                  </div>
                  {natural && speaking !== 'piper' && <div className="dv-spoken">“{natural}”</div>}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="row gap-s muted small"><Info size={14} /> Voz natural (Piper): {NEEDS_V031}.</div>
        )}
        <div className="col gap-s">
          <span className="field-label">Falar um texto</span>
          <form className="row gap-s" onSubmit={(e) => { e.preventDefault(); if (!sayTextError(text)) say('text', sayCmd(text, espeakOpt), null); }}>
            <input className="input grow" value={text} maxLength={300} placeholder={speaksPortuguese(voice) ? 'ex.: O café está pronto' : 'ex.: Coffee is ready'}
              onChange={(e) => setText(e.target.value)} />
            <Button type="submit" icon={<MessageSquare size={14} />} busy={speaking === 'text'} disabled={speaking != null || !text.trim() || !!textErr}>Falar</Button>
          </form>
          {textErr && <span className="st-err" style={{ color: 'var(--bad)', fontSize: 12 }}>{textErr}</span>}
          <span className="field-hint">Com a voz {hasPiper ? 'do espeak' : 'escolhida'}, no volume atual. Se algo já estiver tocando, a fala é ignorada (penguin-sound toca um som por vez).</span>
        </div>
      </div>
    </Card>
  );
}
