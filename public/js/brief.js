/**
 * The briefing.
 *
 * A short written summary of what the weather is about to do, in a flat,
 * factual register — the useful bits, ordered by how much they should change
 * your plans. Optionally read aloud through the browser's speech synthesis.
 */

import {
  fmt as F, compass, dur, dewpointComfort, aqiCategory, uvCategory,
  windDescription, kpCategory, pollenCategory, clamp, escapeHtml,
} from './lib/util.js';
import { precipNowcast, bestWindows, activityMeta, ACTIVITY_KEYS } from './activity.js';

/** Build the briefing as an ordered list of {tone, text} lines. */
export function buildBriefing(store) {
  const tf = store.fmt;
  const f = store.frame(Date.now());
  if (!f) return [];
  const out = [];
  const day = f.day;
  const now = Date.now();

  /* --- headline --- */
  out.push({
    tone: 'lead',
    text: `${tf.full(now)}. It is ${F.temp(f.temp)} and ${f.wx.long.toLowerCase()} in ${store.loc.name}`
      + (Math.abs((f.feels ?? f.temp) - f.temp) >= 3 ? `, feeling like ${F.temp(f.feels)}` : '')
      + '.',
  });

  /* --- alerts first: they outrank everything --- */
  for (const a of store.alerts.slice(0, 3)) {
    out.push({
      tone: 'alert',
      text: `${a.event} in effect until ${tf.weekday(a.expires)} ${tf.hm12(a.expires)}.`
        + (a.instruction ? ` ${firstSentence(a.instruction)}` : ''),
    });
  }

  /* --- the day's shape --- */
  if (day) {
    const climate = store.climate?.doy?.[doyOf(store, now)];
    let line = `Today runs ${F.temp(day.tmin)} to ${F.temp(day.tmax)}`;
    if (climate) {
      const d = day.tmax - climate.normalHigh;
      if (Math.abs(d) >= 3) line += `, ${Math.abs(d).toFixed(0)}° ${d > 0 ? 'above' : 'below'} the normal high of ${F.temp(climate.normalHigh)}`;
      else line += `, right about normal`;
      if (day.tmax >= climate.recordHigh) line += `. That would tie or beat the record of ${F.temp(climate.recordHigh)} set in ${climate.recordHighYear}`;
    }
    out.push({ tone: 'body', text: line + '.' });
  }

  /* --- precipitation --- */
  const nc = precipNowcast(store);
  if (nc?.raining) {
    out.push({
      tone: 'wet',
      text: nc.minutes != null
        ? `It is raining now and should ease within ${nc.minutes} minutes.`
        : `It is raining now, with no break in the next six hours.`,
    });
  } else if (nc?.minutes != null && nc.minutes <= 240) {
    out.push({ tone: 'wet', text: `Rain arrives in about ${nc.minutes} minutes, around ${tf.hm12(nc.changeAt)}.` });
  } else {
    const next = store.hours.find((h) => h.t > now && (h.pop ?? 0) >= 40);
    if (next) {
      out.push({
        tone: 'body',
        text: `Dry for now. The next real chance of rain is ${tf.weekday(next.t)} around ${tf.hm12(next.t)}, at ${Math.round(next.pop)} percent.`,
      });
    } else {
      out.push({ tone: 'body', text: 'No meaningful rain anywhere in the sixteen-day window.' });
    }
  }

  /* --- wind, if it matters --- */
  const maxGust = Math.max(...store.hours
    .filter((h) => h.t > now && h.t < now + 24 * 3600e3)
    .map((h) => h.gust ?? 0), 0);
  if (maxGust >= 22) {
    out.push({
      tone: 'warn',
      text: `Wind is worth planning around: gusts reach ${Math.round(maxGust)} miles per hour today, ${windDescription(maxGust).effect}.`,
    });
  }

  /* --- comfort --- */
  const cmf = dewpointComfort(f.dew);
  if (['STICKY', 'HUMID', 'OPPRESSIVE', 'MISERABLE', 'LETHAL'].includes(cmf.name)) {
    out.push({ tone: 'warn', text: `The air is ${cmf.name.toLowerCase()} — dew point ${F.temp(f.dew)}, ${cmf.note}.` });
  } else if (cmf.name === 'VERY DRY') {
    out.push({ tone: 'body', text: `Very dry air, dew point ${F.temp(f.dew)}. Expect static and chapped lips.` });
  }

  /* --- sun and UV --- */
  const uvMax = day?.uvMax;
  if (uvMax != null && uvMax >= 6) {
    const burn = Math.round(350 / (uvMax * 15));
    out.push({
      tone: 'warn',
      text: `UV peaks at ${uvMax.toFixed(1)}, ${uvCategory(uvMax).name.toLowerCase()}. Unprotected skin burns in roughly ${burn} minutes.`,
    });
  }

  /* --- air quality and pollen --- */
  const aqi = f.air?.aqi ?? store.airNow?.aqi;
  if (aqi != null && aqi > 75) {
    out.push({ tone: 'warn', text: `Air quality is ${aqiCategory(aqi).name.toLowerCase()} at ${Math.round(aqi)} on the US index.` });
  }
  const pol = store.pollen;
  if (pol?.index != null && pol.index >= 7) {
    const trig = (pol.triggers || []).map((t) => t.name).slice(0, 3).join(', ');
    out.push({
      tone: 'warn',
      text: `Pollen is ${pollenCategory(pol.index).name.toLowerCase().replace('-', ' to ')} at ${pol.index.toFixed(1)} of 12${trig ? `, driven by ${trig}` : ''}.`,
    });
  }

  /* --- the best thing to do outside --- */
  const picks = ACTIVITY_KEYS
    .map((k) => ({ k, w: bestWindows(k, store, { hours: 24, limit: 1, minScore: 62 })[0] }))
    .filter((x) => x.w)
    .sort((a, b) => b.w.peak - a.w.peak)
    .slice(0, 2);
  for (const p of picks) {
    const m = activityMeta(p.k);
    out.push({
      tone: 'good',
      text: `Best window to ${m.label.toLowerCase()}: ${tf.weekday(p.w.start)} ${tf.hm12(p.w.start)} to ${tf.hm12(p.w.end)}, scoring ${p.w.peak} out of 100.`,
    });
  }

  /* --- sky, if anything is happening up there --- */
  const kp = store.currentKp();
  if (kp != null && kp >= 5) {
    const c = kpCategory(kp);
    out.push({ tone: 'space', text: `Geomagnetic activity is elevated: Kp ${kp.toFixed(1)}, ${c.name}. Aurora may be visible to about ${c.lat} degrees latitude.` });
  }
  const st = store.sunTimesFor(now);
  out.push({
    tone: 'body',
    text: `Sunset is at ${tf.hm12(st.sunset)}, with golden hour beginning ${tf.hm12(st.goldenHour)}`
      + (day?.daylight ? ` and ${dur(day.daylight)} of daylight today` : '') + '.',
  });

  return out;
}

const firstSentence = (s) => {
  const m = String(s).replace(/\s+/g, ' ').match(/^.{0,180}?[.!?](\s|$)/);
  return (m ? m[0] : String(s).slice(0, 180)).trim();
};

function doyOf(store, t) {
  const [, m, d] = store.fmt.isoDate(t).split('-').map(Number);
  return [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335][m - 1] + d - 1;
}

const TONE_COLOR = {
  lead: 'var(--cy)', alert: 'var(--rd)', warn: 'var(--am)',
  wet: 'var(--ice)', good: 'var(--lm)', space: 'var(--vi)', body: 'var(--ink)',
};

export function showBriefing(store, openModal) {
  const lines = buildBriefing(store);
  openModal(`
    <div class="hd">BRIEFING<span class="rule"></span>
      <span class="val">${escapeHtml(store.loc.name.toUpperCase())} · ${store.fmt.hm(Date.now())}</span></div>
    <div class="res-list" style="max-height:60vh">
      ${lines.map((l, i) => `
        <p style="
          margin:0 0 10px;
          font-size:${i === 0 ? '.92rem' : '.8rem'};
          line-height:1.6;
          color:${TONE_COLOR[l.tone] || 'var(--ink)'};
          ${l.tone === 'alert' ? 'border-left:2px solid var(--rd);padding-left:10px;' : ''}
          ${i === 0 ? 'font-weight:600;' : ''}
        ">${escapeHtml(l.text)}</p>`).join('')}
    </div>
    <div style="display:flex;gap:6px;margin-top:12px">
      <button class="tl-btn" id="speakBtn">▶ SPEAK</button>
      <button class="tl-btn" id="stopBtn">■ STOP</button>
    </div>
  `, (card) => {
    const speak = () => {
      if (!window.speechSynthesis) return;
      speechSynthesis.cancel();
      const text = lines.map((l) => l.text).join(' ');
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.pitch = 0.85;   // flat and dry, not cheerful
      // Prefer a local English voice; the default is often a poor cloud one.
      const v = speechSynthesis.getVoices().find((x) => /en[-_](GB|US)/.test(x.lang) && x.localService);
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    };
    card.querySelector('#speakBtn').addEventListener('click', speak);
    card.querySelector('#stopBtn').addEventListener('click', () => speechSynthesis?.cancel());
    if (store.settings.voice) setTimeout(speak, 220);
  });
}


