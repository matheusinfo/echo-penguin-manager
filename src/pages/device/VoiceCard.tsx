// "Alarme & Tela" → Voz: the espeak-ng voice (SPEAK_VOICE), speaking after an alarm (SPEAK_ALARM) and
// a test that says what the Echo says after an alarm. echo-penguin v0.3.0+.
import { useState } from 'react';
import { MessageSquare, Play, Speech, TriangleAlert } from 'lucide-react';
import { errMsg, run } from '../../api';
import { useApp } from '../../hooks';
import { Button, Card, Switch } from '../../components/ui';
import { COMMON_VOICES, SAY_GREETING_CMD, sayCmd, sayTextError, speaksPortuguese, validVoice, voiceLabel } from '../weather';
import { Custom, DevState, NeedsVersion, SetLive } from './common';

export function voiceSupported(data: DevState): boolean {
  return data.features.say && 'SPEAK_VOICE' in data.defaults;
}

export function VoiceCard({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  const { toast } = useApp();
  const [spoken, setSpoken] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [speaking, setSpeaking] = useState<string | null>(null);

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

  const say = async (key: string, cmd: string, show: boolean) => {
    setSpeaking(key);
    try {
      const out = (await run(cmd, { timeout: 90000 })).trim();
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
        {!data.features.espeak && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>O espeak-ng não está instalado neste Echo: ele não consegue falar.</div></div>
        )}
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Voz <span className="mono muted small">SPEAK_VOICE</span><Custom data={data} k="SPEAK_VOICE" /></div>
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
            <Button variant="primary" icon={<Play size={14} />} busy={speaking === 'greet'} disabled={speaking != null} onClick={() => say('greet', SAY_GREETING_CMD, true)}
              title={'penguin-sound say "$(penguin-weather speech)"'}>Testar voz</Button>
            <span className="muted small">o que o Echo diz depois do alarme</span>
          </div>
          {spoken && <div className="dv-spoken">“{spoken}”</div>}
        </div>
        <div className="col gap-s">
          <span className="field-label">Falar um texto</span>
          <form className="row gap-s" onSubmit={(e) => { e.preventDefault(); if (!sayTextError(text)) say('text', sayCmd(text), false); }}>
            <input className="input grow" value={text} maxLength={300} placeholder={speaksPortuguese(voice) ? 'ex.: O café está pronto' : 'ex.: Coffee is ready'}
              onChange={(e) => setText(e.target.value)} />
            <Button type="submit" icon={<MessageSquare size={14} />} busy={speaking === 'text'} disabled={speaking != null || !text.trim() || !!textErr}>Falar</Button>
          </form>
          {textErr && <span className="st-err" style={{ color: 'var(--bad)', fontSize: 12 }}>{textErr}</span>}
          <span className="field-hint">Com a voz escolhida, no volume atual. Se algo já estiver tocando, a fala é ignorada (penguin-sound toca um som por vez).</span>
        </div>
      </div>
    </Card>
  );
}
