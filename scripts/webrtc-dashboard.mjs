#!/usr/bin/env node

import process from 'node:process';
import readline from 'node:readline/promises';

const WORKER_URL = process.env.WEBRTC_WORKER_URL || process.env.WEBRTC_DASHBOARD_URL;
const API_TOKEN = process.env.WEBRTC_API_TOKEN || process.env.WEBRTC_TOKEN || '';

const ENDPOINT_CANDIDATES = [
  '/api/sessions?state=active',
  '/api/calls?state=active',
  '/sessions?state=active',
  '/calls?state=active',
];

const OBSERVER_ENDPOINT_CANDIDATES = [
  (id) => `/api/sessions/${id}/observer`,
  (id) => `/api/sessions/${id}/observe`,
  (id) => `/api/calls/${id}/observer`,
  (id) => `/session/${id}/observer`,
];

const headers = {
  'Content-Type': 'application/json',
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
};

function makeUrl(path) {
  if (!WORKER_URL) {
    throw new Error('Missing WEBRTC_WORKER_URL. Example: export WEBRTC_WORKER_URL=https://your-worker.example.com');
  }

  const base = WORKER_URL.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function requestJson(path, init = {}) {
  const response = await fetch(makeUrl(path), {
    ...init,
    headers: {
      ...headers,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;

  if (!response.ok) {
    const message = typeof body === 'string' ? body : body?.error || body?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function normalizeSessionList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (Array.isArray(payload?.calls)) return payload.calls;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

function formatTime(value) {
  if (!value) return 'n/a';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatParticipants(session) {
  const participants = session?.participants ?? session?.users ?? session?.members ?? [];
  if (!participants.length) return '0';
  return String(participants.length);
}

function formatStatus(session) {
  return session?.status || session?.state || 'active';
}

function pickSessionId(session) {
  return session?.id ?? session?.sessionId ?? session?.callId ?? session?.uuid ?? session?.key;
}

function pickObserverUrl(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.observerUrl || payload.streamUrl || payload.viewerUrl || payload.url || payload.data?.observerUrl || payload.data?.streamUrl || null;
}

async function fetchActiveSessions() {
  let lastError;
  for (const endpoint of ENDPOINT_CANDIDATES) {
    try {
      const data = await requestJson(endpoint, { method: 'GET' });
      const sessions = normalizeSessionList(data);
      if (Array.isArray(sessions) && sessions.length) {
        return { sessions, endpoint };
      }
      if (Array.isArray(sessions)) {
        return { sessions, endpoint };
      }
      lastError = new Error(`Empty response from ${endpoint}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return { sessions: [], endpoint: null };
}

async function requestObserverSession(sessionId) {
  let lastError;

  for (const fn of OBSERVER_ENDPOINT_CANDIDATES) {
    const endpoint = fn(sessionId);
    try {
      const data = await requestJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          mode: 'observer',
          allowViewer: true,
          directStream: true,
          joinCall: false,
          requireConsent: true,
        }),
      });

      const streamUrl = pickObserverUrl(data);
      if (streamUrl) {
        return { ...data, streamUrl };
      }

      if (data && (data.sessionId || data.id || data.status || data.url)) {
        return data;
      }

      lastError = new Error(`Observer endpoint responded without a stream URL: ${endpoint}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('No observer-only endpoint responded. Update OBSERVER_ENDPOINT_CANDIDATES for your worker API.');
}

async function printDashboard() {
  const { sessions } = await fetchActiveSessions();

  if (!sessions.length) {
    console.log('No active sessions found.');
    return;
  }

  console.log('Ongoing sessions');
  console.log('=================');
  sessions.forEach((session, index) => {
    const id = pickSessionId(session);
    const label = session?.label || session?.name || session?.title || session?.callName || 'session';
    console.log(
      `[${index + 1}] ${String(id ?? 'unknown').padEnd(12)} | status=${String(formatStatus(session)).padEnd(10)} | ${formatParticipants(session)} participants | ${formatTime(session?.startedAt ?? session?.createdAt ?? session?.started_at)}`
    );
    if (label && label !== id) {
      console.log(`      label: ${label}`);
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Select a session number to open observer stream (or press Enter to exit): ');
  rl.close();

  if (!answer || Number.isNaN(Number(answer))) {
    console.log('Exiting.');
    return;
  }

  const idx = Number(answer) - 1;
  const selected = sessions[idx];
  if (!selected) {
    console.log('Invalid selection.');
    return;
  }

  const sessionId = pickSessionId(selected);
  console.log(`Requesting observer-only stream for session ${sessionId}...`);

  try {
    const result = await requestObserverSession(sessionId);
    const streamUrl = result.streamUrl || result.liveStreamUrl || result.url || result?.data?.streamUrl;

    if (streamUrl) {
      console.log('Observer stream ready:');
      console.log(streamUrl);
      if (result?.expiresAt) {
        console.log(`Expires at: ${result.expiresAt}`);
      }
    } else {
      console.log('Observer request accepted. Inspect the worker response below:');
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('observer request failed:');
    console.error(error.message || error);
    console.log('');
    console.log('Your worker API likely uses different route names or payload keys.');
    console.log('Edit ENDPOINT_CANDIDATES and OBSERVER_ENDPOINT_CANDIDATES in this script to match your worker contract.');
    process.exitCode = 1;
  }
}

(async function main() {
  try {
    await printDashboard();
  } catch (error) {
    console.error('Failed to load dashboard state.');
    console.error(error.message || error);
    console.log('');
    console.log('Expected env vars:');
    console.log('  export WEBRTC_WORKER_URL=https://example.workers.dev');
    console.log('  export WEBRTC_API_TOKEN=your-token (optional)');
    console.log('');
    console.log('This script expects a worker with active session endpoints and an observer-only API that does not join the call.');
    process.exitCode = 1;
  }
})();

