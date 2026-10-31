#!/usr/bin/env node
// APC40 mkII <-> Sequins Patches bridge.
//
// Session launcher (5x8 grid, scenes, clip stop, transport) with LED feedback, ported from
// DrivenByMoss' APC session view. Knobs, faders and every other CC are NOT handled here: they
// are forwarded to the virtual MIDI port "APC40 Knobs", so they can be mapped in Patches
// (`map cc 16 port "APC40 Knobs" -> pad_filter.cutoff`, or the window's learn) to anything.
//
// Usage: node bridge.js   (see README.md)

const net = require('net')
const os = require('os')
const midi = require('@julusian/midi')
const fs = require('fs')
const STATE_FILE = `${__dirname}/state.json`

const SOCKET = process.env.PATCHES_SOCKET || `${os.homedir()}/Library/Application Support/Sequins Patches/run/patchesd.sock`
const APC_PORT = /APC40 mkII/i
const VIRTUAL_PORT = 'APC40 Knobs'
const ROWS = 5
const COLS = 8

// Notes (DrivenByMoss APCControlSurface)
const N_CLIP_STOP = 0x34
const N_STOP_ALL = 0x51
const N_SCENE_1 = 0x52
const N_PLAY = 0x5b
const N_STOP = 0x5c
const N_RECORD = 0x5d
const N_UP = 0x5e
const N_DOWN = 0x5f
const N_RIGHT = 0x60
const N_LEFT = 0x61
const N_SESSION = 0x66
const N_METRONOME = 0x5a
const N_BANK_LEFT = 0x3c
const N_BANK_RIGHT = 0x3d
const N_DEV_LEFT = 0x3a
const N_DEV_RIGHT = 0x3b
const N_DEV_ONOFF = 0x3e
const N_QUANTIZE = 0x3f
const N_TAP = 0x63
const N_UNDO = 0x64
const N_REDO = 0x65
const N_BANK = 0x67
const CC_CUE = 0x2f
const N_MASTER = 0x50 // overlaps the scene-launch range only in name: scenes start at 0x52
const CC_TEMPO = 0x0d
const QUANTIZES = ['none', '4bar', '2bar', '1bar', '2n', '4n', '8n', '16n']

// mkII palette (APCColorManager)
const C_OFF = 0
const C_GREEN = 21
const C_AMBER = 10
const C_RED = 5
const C_WHITE = 3

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

// ---------------------------------------------------------------- MIDI

let input = null
let output = null
let knobsOut = null
const ledCache = new Map()

function sendCC(cc, value) {
  if (output) output.sendMessage([0xb0, cc, value])
}

function findPort(io, re) {
  for (let i = 0; i < io.getPortCount(); i++) if (re.test(io.getPortName(i))) return i
  return -1
}

function openApc() {
  const i = new midi.Input()
  const o = new midi.Output()
  const ii = findPort(i, APC_PORT)
  const oi = findPort(o, APC_PORT)
  if (ii < 0 || oi < 0) {
    i.closePort?.()
    return false
  }
  i.ignoreTypes(true, true, true)
  i.on('message', (_dt, msg) => onApcMessage(msg))
  i.openPort(ii)
  o.openPort(oi)
  input = i
  output = o
  ledCache.clear()
  // Ableton mode: the host drives every LED and the grid sends notes 0x35-0x39. The device
  // can miss the message right after the port opens, so it is sent again a moment later.
  const mode = () => output && output.sendMessage([0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x41, 0x08, 0x02, 0x01, 0xf7])
  mode()
  setTimeout(mode, 500)
  setTimeout(() => {
    ledCache.clear()
    render()
    refreshMix()
    renderBank()
  }, 700)
  // Knob rings show their value
  for (let k = 0; k < 8; k++) {
    sendCC(0x18 + k, 1)
    sendCC(0x38 + k, 1)
  }
  log('APC40 mkII connected')
  render()
  return true
}

function closeApc(reason) {
  if (!input) return
  try {
    if (output) {
      for (let n = 0; n < 0x68; n++) for (let ch = 0; ch < 8; ch++) output.sendMessage([0x90 | ch, n, 0])
      // back to generic mode so the controller is usable elsewhere
      output.sendMessage([0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x40, 0x08, 0x02, 0x01, 0xf7])
    }
    input.closePort()
    output.closePort()
  } catch (e) {
  }
  input = output = null
  if (reason) log('APC40 mkII', reason)
}

function openKnobsPort() {
  knobsOut = new midi.Output()
  knobsOut.openVirtualPort(VIRTUAL_PORT)
  log(`virtual port "${VIRTUAL_PORT}" open: map knobs and faders from it in Patches`)
}

// ---------------------------------------------------------------- Patches RPC

let sock = null
let nextId = 10
let buf = ''
const pending = new Map()
let state = { tracks: [], scene: {} }
let transport = { playing: false }
let trackOffset = 0
let trackOrder = new Map()

// The launcher lists tracks in creation order; the window (and the controller) use `order`.
function cols() {
  const rank = (t) => (trackOrder.has(t.track) ? trackOrder.get(t.track) : 1e9)
  return [...state.tracks].sort((a, b) => rank(a) - rank(b))
}

async function refreshOrder() {
  try {
    const r = await rpc('tracks.get', {})
    trackOrder = new Map((r.tracks || []).map((t) => [t.name, t.order]))
    render()
    applyKnobMaps()
  } catch (e) {
  }
}
let orderTimer = null
let sceneOffset = 0

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!sock) return reject(new Error('not connected'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function call(method, params) {
  return rpc(method, params).catch((e) => log('rpc failed:', method, e.message))
}

let connecting = false

function connectPatches() {
  if (connecting) return
  connecting = true
  const s = net.connect(SOCKET)
  buf = ''
  s.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) onRpcLine(line)
    }
  })
  s.on('connect', async () => {
    sock = s
    try {
      await rpc('session.hello', {
        protocol: ['patches/1'],
        client: { name: 'apc40-bridge', version: '0.1.0', kind: 'cli' },
      })
      await rpc('sub.listen', { topics: ['launcher', 'transport', 'graph'] })
      const t = await rpc('transport.get', {})
      transport = t
      log('Patches connected')
      refreshOrder()
      refreshMix()
      render()
    } catch (e) {
      log('Patches handshake failed:', e.message)
      s.destroy()
    }
  })
  const lost = () => {
    connecting = false
    if (sock === s) {
      sock = null
      log('Patches disconnected, retrying')
      pending.forEach((p) => p.reject(new Error('disconnected')))
      pending.clear()
      render()
    }
  }
  s.on('close', lost)
  s.on('error', () => {})
}

function onRpcLine(line) {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m.result)
    return
  }
  if (m.method === 'sub.event') {
    const { topic, payload } = m.params
    if (topic === 'graph') {
      // Our own knob writes come back as graph events: reacting to them is a feedback loop
      if (JSON.stringify(payload.label || '').includes('APC40 knobs')) return
      clearTimeout(orderTimer)
      orderTimer = setTimeout(() => {
        refreshOrder()
        knobMode.kind === 'user' ? refreshUser() : refreshMix()
      }, 300)
      return
    }
    if (topic === 'launcher') {
      state = payload
    } else if (topic === 'transport') {
      const was = transport.playing
      const arms = JSON.stringify(transport.arms)
      transport = { ...transport, ...payload, click: !!payload.click, record: payload.record }
      if (JSON.stringify(transport.arms) !== arms) renderButtons()
      if (transport.playing === was) return
    }
    render()
  }
}

// ---------------------------------------------------------------- Track buttons

const N_ARM = 0x30
const N_SOLO = 0x31
const N_MUTE = 0x32
const N_TRACK_SELECT = 0x33
let selected = new Set()

function renderButtons() {
  if (!output) return
  const armed = new Set((transport.arms || []).map((a) => String(a).split(' ')[0]))
  for (let c = 0; c < COLS; c++) {
    const t = sock ? cols()[trackOffset + c] : undefined
    const info = t && mix.get(t.track)
    ledCol(N_ARM, c, t && armed.has(t.track) ? 1 : 0)
    ledCol(N_SOLO, c, info && info.solo ? 1 : 0)
    ledCol(N_MUTE, c, info && info.mute ? 1 : 0)
    ledCol(N_TRACK_SELECT, c, t && selected.has(t.track) ? 1 : 0)
  }
  const rec = isRecording() ? 1 : 0
  ledCol(N_RECORD, 0, rec)
  ledCol(N_SESSION, 0, rec)
  ledCol(N_METRONOME, 0, transport.click ? 1 : 0)
  ledCol(N_QUANTIZE, 0, transport.quantize && transport.quantize !== 'none' ? 1 : 0)
  ledCol(N_MASTER, 0, selected.has('out') ? 1 : 0)
}

const isRecording = () => !!transport.record && transport.record.state !== 'off' && transport.record !== false

// ---- "Device" = a module of the selected track, in the order the track lays them out
let device = { modules: [], index: -1, on: false }

// ---- Bank: pages of the 8 device knobs. Each page leaves on its own block of CCs, free for
// the user's mappings; the rings remember each page's values.
const BANK_BASE = [16, 24, 110, 118]
const bankVals = BANK_BASE.map(() => new Array(8).fill(0))
let bankPage = 0
try {
  bankPage = Math.max(0, Math.min(BANK_BASE.length - 1, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).bankPage || 0))
} catch {}

function renderBank() {
  if (!output) return
  ledCol(N_BANK_LEFT, 0, bankPage > 0 ? 1 : 0)
  ledCol(N_BANK_RIGHT, 0, bankPage < BANK_BASE.length - 1 ? 1 : 0)
  for (let i = 0; i < 8; i++) {
    const v = bankVals[bankPage][i]
    if (ledCache.get(`bankv${i}`) !== v) {
      ledCache.set(`bankv${i}`, v)
      sendCC(0x10 + i, v)
    }
  }
}

function setBankPage(p) {
  bankPage = Math.max(0, Math.min(BANK_BASE.length - 1, p))
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...knobMode, bankPage }))
  } catch {}
  log(`bank page ${bankPage + 1}/${BANK_BASE.length}: device knobs leave as CC ${BANK_BASE[bankPage]}..${BANK_BASE[bankPage] + 7}`)
  renderBank()
}

async function refreshDevice() {
  try {
    const sel = await rpc('selection.get', {})
    const item = ((sel.current && sel.current.items) || [])[0]
    if (!item) return (device = { modules: [], index: -1, on: false })
    const trackName = item.kind === 'track' ? item.name : item.home
    const tr = ((await rpc('tracks.get', {})).tracks || []).find((x) => x.name === trackName)
    if (!tr) return (device = { modules: [], index: -1, on: false })
    const text = (await rpc('patch.export', { format: 'dsl' })).text
    const x = (m) => {
      const hit = text.match(new RegExp(`(?:^|\\n)(?:place )?${m}\\b[^\\n]*? at (-?\\d+),(-?\\d+)`))
      return hit ? Number(hit[1]) : 1e6
    }
    const modules = (tr.modules || []).filter((m) => m !== trackName).sort((a, b) => x(a) - x(b) || a.localeCompare(b))
    const index = item.kind === 'track' ? -1 : modules.indexOf(item.name)
    const on = index >= 0 ? !new RegExp(`^${item.name}\\.on = off`, 'm').test(text) : false
    device = { modules, index, on }
  } catch (e) {
  }
  renderDevice()
}

function renderDevice() {
  if (!output) return
  const n = device.modules.length
  ledCol(N_DEV_LEFT, 0, n && device.index !== 0 ? 1 : 0)
  ledCol(N_DEV_RIGHT, 0, n && device.index !== n - 1 ? 1 : 0)
  ledCol(N_DEV_ONOFF, 0, device.index >= 0 && device.on ? 1 : 0)
}

async function stepModule(dir) {
  await refreshDevice()
  const n = device.modules.length
  if (!n) return
  const next = device.index < 0 ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, device.index + dir))
  await rpc('selection.select', { addresses: [device.modules[next]] }).catch((e) => log('select failed:', e.message))
  log('module:', device.modules[next])
  refreshDevice()
}

async function toggleModule() {
  await refreshDevice()
  if (device.index < 0) return log('no module selected: use the arrows first')
  const m = device.modules[device.index]
  await rpc('dsl.eval', { src: `${m}.on = ${device.on ? 'off' : 'on'}`, label: 'APC40 device on/off' }).catch((e) => log('on/off failed:', e.message))
  refreshDevice()
}

// The big BANK button: the sample browser on a sample / loop / kit module, else the next view
const VIEWS = ['graph', 'mixer', 'arrange']
let view = 0
async function browse() {
  try {
    const sel = await rpc('selection.get', {})
    const item = ((sel.current && sel.current.items) || [])[0]
    if (item && /^(sample|loop|kit)\b/.test(item.detail || '')) {
      await rpc('samples.browse', { node: item.address })
      return log('sample browser:', item.address)
    }
    view = (view + 1) % VIEWS.length
    await rpc('view.ui', { mode: VIEWS[view] })
    log('view:', VIEWS[view])
  } catch (e) {
    log('bank button failed:', e.message)
  }
}

// The cue knob moves the playhead a bar per click
let cueDelta = 0
let cueTimer = null
function moveCue(delta) {
  cueDelta += delta
  if (cueTimer) return
  cueTimer = setTimeout(() => {
    cueTimer = null
    const perBar = (transport.meter && transport.meter[0]) || 4
    const bar = Math.max(1, Math.floor((transport.beat || 0) / perBar) + 1 + cueDelta)
    cueDelta = 0
    transport.beat = (bar - 1) * perBar
    call('transport.set', { position: String(bar) })
  }, 150)
}

let tempoDelta = 0
let tempoTimer = null
function nudgeTempo(delta) {
  tempoDelta += delta
  if (tempoTimer) return
  tempoTimer = setTimeout(() => {
    tempoTimer = null
    const bpm = Math.max(20, Math.min(300, Math.round(((transport.tempo || 120) + tempoDelta * 0.5) * 2) / 2))
    tempoDelta = 0
    transport.tempo = bpm
    setTempo(bpm)
  }, 120)
}

function setTempo(bpm) {
  call('transport.set', { tempo: bpm })
}

let taps = []
function tapTempo() {
  const now = Date.now()
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = []
  taps.push(now)
  taps = taps.slice(-5)
  if (taps.length < 2) return
  const gaps = taps.slice(1).map((t, i) => t - taps[i])
  const bpm = Math.round((60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)) * 10) / 10
  if (bpm >= 30 && bpm <= 300) setTempo(bpm)
}

// Show the press at once; the poll below corrects it if Patches ended up elsewhere
function flipButton(c, note) {
  const t = cols()[trackOffset + c]
  if (!t) return
  const info = mix.get(t.track)
  if (note === N_MUTE && info) info.mute = !info.mute
  else if (note === N_SOLO && info) info.solo = !info.solo
  else if (note === N_ARM) {
    const armed = (transport.arms || []).some((a) => String(a).split(' ')[0] === t.track)
    transport = { ...transport, arms: armed ? [] : [t.track] }
  }
  renderButtons()
  setTimeout(pollButtons, 120)
}

// Arm, solo and mute changes do not always announce themselves: look at them twice a second
async function pollButtons() {
  if (!sock || !output) return
  try {
    const [r, t, sel] = await Promise.all([rpc('mixer.get', {}), rpc('transport.get', {}), rpc('selection.get', {})])
    const nextSel = new Set(((sel.current && sel.current.items) || []).map((i) => i.address))
    const changed = [...nextSel].join() !== [...selected].join()
    selected = nextSel
    if (changed) refreshDevice()
    for (const x of r.strips) {
      const m = mix.get(x.name)
      if (m) {
        m.mute = !!x.mute
        m.solo = !!x.solo
      }
    }
    transport = { ...transport, ...t, click: !!t.click, record: t.record } // absent means off
    renderButtons()
  } catch (e) {
  }
}
setInterval(pollButtons, 300)

// ---------------------------------------------------------------- Pan / Send / User

const N_PAN = 0x57
const N_SENDS = 0x58
const N_USER = 0x59
const K_TRACK = 0x30 // track knobs 0x30..0x37
const K_USER = 102 // in User mode the same knobs leave as CC 102..109, free for the user's own mappings
const userVals = new Array(8).fill(0)
const RING_VOLUME = 2
const RING_PAN = 3

let knobMode = { kind: 'pan', send: 0, userTrack: false }
try {
  knobMode = { ...knobMode, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } // the mode survives a restart
} catch {}
let mix = new Map() // track -> { pan, sends: [db] }
let sendCount = 2
let userMacros = [] // macros of the current User target, by slot
let userOwner = 'master'

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const dbFromCC = (v) => (v === 0 ? -96 : -60 + (v / 127) * 60)
const ccFromDb = (db) => clamp(Math.round(((db + 60) / 60) * 127), 0, 127)

async function refreshMix() {
  try {
    const r = await rpc('mixer.get', {})
    mix = new Map(r.strips.filter((x) => x.sends).map((x) => [x.name, { pan: x.pan, sends: x.sends.map((q) => q.db), mute: !!x.mute, solo: !!x.solo }]))
    sendCount = Math.max(1, ...[...mix.values()].map((m) => m.sends.length))
    renderButtons()
  } catch (e) {
  }
  renderKnobs()
  applyKnobMaps()
}

async function refreshUser() {
  try {
    let owner = 'Master'
    if (knobMode.userTrack) {
      const sel = await rpc('selection.get', {})
      const item = sel.current && sel.current.items && sel.current.items.find((i) => i.kind === 'track')
      owner = item ? item.name : null
    }
    userOwner = owner
    const r = await rpc('macros.get', {})
    const o = (r.owners || []).find((x) => String(x.owner).toLowerCase() === String(owner).toLowerCase())
    userMacros = []
    for (const m of (o && o.macros) || []) userMacros[m.slot - 1] = m
  } catch (e) {
  }
  renderKnobs()
  applyKnobMaps()
}

function knobTarget(i) {
  const t = cols()[trackOffset + i]
  if (knobMode.kind === 'user') return null // free knobs: the user maps them
  if (!t) return null
  const info = mix.get(t.track)
  if (!info) return null
  if (knobMode.kind === 'pan') {
    return { target: `${t.track}.pan -1..1`, value: (info.pan + 1) / 2, update: (v) => (info.pan = v / 127 * 2 - 1) }
  }
  const k = knobMode.send
  if (info.sends[k] === undefined) return null
  return { target: `${t.track}.send${k + 1} -60db..0db`, value: ccFromDb(info.sends[k]) / 127, update: (v) => (info.sends[k] = dbFromCC(v)) }
}

// The knobs are native Patches mappings, re-pointed whenever the mode, the column or the
// selection changes. Moving them is then Patches' own business: no queue of submissions.
// A control may have several targets in Patches, so the old one is unmapped before the new
// one is mapped, comparing with what the song holds right now.
let applying = false
let applyAgain = false

async function applyKnobMaps() {
  if (applying) {
    applyAgain = true
    return
  }
  applying = true
  try {
    do {
      applyAgain = false
      const dsl = (await rpc('patch.export', { format: 'dsl' })).text
      const held = new Map() // cc -> [target text]
      const re = new RegExp(`^map cc (\\d+) port "${VIRTUAL_PORT}" -> (.+)$`, 'gm')
      for (const m of dsl.matchAll(re)) {
        const cc = Number(m[1])
        if (cc < K_TRACK || cc > K_TRACK + 7) continue
        if (!held.has(cc)) held.set(cc, [])
        held.get(cc).push(m[2].trim())
      }
      const unmaps = []
      const maps = []
      const heldNotes = new Map() // "note/ch" -> target
      const reNote = new RegExp(`^map note (\\d+) ch (\\d+) port "${VIRTUAL_PORT}" -> (\\S+)$`, 'gm')
      for (const m of dsl.matchAll(reNote)) heldNotes.set(`${m[1]}/${m[2]}`, m[3])
      for (let c = 0; c < COLS; c++) {
        const t = cols()[trackOffset + c]
        for (const [note, what] of [[N_ARM, 'arm'], [N_SOLO, 'solo'], [N_MUTE, 'mute']]) {
          const have = heldNotes.get(`${note}/${c + 1}`)
          const want = t ? `${t.track}.${what}` : null
          if (have === want) continue
          if (have) unmaps.push(`unmap note ${note} ch ${c + 1} port "${VIRTUAL_PORT}"`)
          if (want) maps.push(`map note ${note} ch ${c + 1} port "${VIRTUAL_PORT}" -> ${want}`)
        }
      }
      for (let i = 0; i < 8; i++) {
        const cc = K_TRACK + i
        const tg = knobTarget(i)
        const have = held.get(cc) || []
        const want = tg ? tg.target : null
        if (have.length === 1 && want && have[0] === want) continue
        if (!have.length && !want) continue
        if (have.length) unmaps.push(`unmap cc ${cc} port "${VIRTUAL_PORT}"`)
        if (want) maps.push(`map cc ${cc} port "${VIRTUAL_PORT}" -> ${want}`)
      }
      // A new map moves its target off the old control, so every unmap goes first
      const lines = [...unmaps, ...maps]
      if (lines.length) await rpc('dsl.eval', { src: `step "APC40 knobs" {\n${lines.join('\n')}\n}`, label: 'APC40 knobs' })
    } while (applyAgain)
  } catch (e) {
    log('knob mapping failed:', e.message)
  } finally {
    applying = false
  }
}

function renderKnobs() {
  if (!output) return
  const ringMode = knobMode.kind === 'pan' ? RING_PAN : RING_VOLUME
  for (let i = 0; i < 8; i++) {
    const tg = knobTarget(i)
    const free = knobMode.kind === 'user'
    const mode = tg || free ? ringMode : 1
    const value = free ? userVals[i] : tg ? clamp(Math.round(tg.value * 127), 0, 127) : 0
    if (ledCache.get(`ringm${i}`) !== mode) {
      ledCache.set(`ringm${i}`, mode)
      sendCC(0x38 + i, mode)
    }
    if (ledCache.get(`ringv${i}`) !== value) {
      ledCache.set(`ringv${i}`, value)
      sendCC(K_TRACK + i, value)
    }
  }
  ledCol(N_PAN, 0, knobMode.kind === 'pan' ? 1 : 0)
  ledCol(N_SENDS, 0, knobMode.kind === 'send' ? 1 : 0)
  ledCol(N_USER, 0, knobMode.kind === 'user' ? 1 : 0)
}

function setKnobMode(next) {
  knobMode = next
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...knobMode, bankPage }))
  } catch {}
  log('knobs:', knobMode.kind, knobMode.kind === 'send' ? `send ${knobMode.send + 1}` : knobMode.kind === 'user' ? `free, CC ${K_USER}..${K_USER + 7} on "${VIRTUAL_PORT}"` : '')
  refreshMix()
  renderKnobs()
  applyKnobMaps()
}

function onTrackKnob(i, v) {
  const tg = knobTarget(i)
  if (!tg) return
  tg.update(v)
  ledCache.set(`ringv${i}`, v)
  sendCC(K_TRACK + i, v)
}

// ---------------------------------------------------------------- APC input

function onApcMessage(msg) {
  const [status, d1, d2] = msg
  const type = status & 0xf0
  const ch = status & 0x0f
  if (type === 0xb0) {
    if (d1 === CC_CUE) return moveCue(d2 < 64 ? d2 : d2 - 128)
    if (d1 === CC_TEMPO) return nudgeTempo(d2 < 64 ? d2 : d2 - 128)
    // Track knobs belong to the Pan / Send / User modes, the rest goes to the user's mappings
    if (d1 >= K_TRACK && d1 <= K_TRACK + 7) {
      const i = d1 - K_TRACK
      if (knobMode.kind === 'user') {
        userVals[i] = d2
        ledCache.set(`ringv${i}`, d2)
        sendCC(d1, d2)
        if (knobsOut) knobsOut.sendMessage([status, K_USER + i, d2])
        return
      }
      onTrackKnob(i, d2)
    }
    if (d1 >= 0x10 && d1 <= 0x17) {
      const i = d1 - 0x10
      bankVals[bankPage][i] = d2
      ledCache.set(`bankv${i}`, d2)
      sendCC(d1, d2) // the ring follows its knob
      if (knobsOut) knobsOut.sendMessage([status, BANK_BASE[bankPage] + i, d2])
      return
    }
    if (knobsOut) knobsOut.sendMessage(msg)
    return
  }
  if (type === 0x90 && d2 > 0 && ch < COLS && d1 === N_TRACK_SELECT) {
    const t = cols()[trackOffset + ch]
    if (t) {
      selected = new Set([t.track])
      renderButtons()
      call('selection.select', { addresses: [t.track] }).then(() => setTimeout(pollButtons, 80))
    }
    return
  }
  if ((type === 0x90 || type === 0x80) && ch < COLS && d1 >= N_ARM && d1 <= N_MUTE) {
    if (knobsOut) knobsOut.sendMessage(msg) // REC / SOLO / MUTE are native Patches mappings
    if (type === 0x90 && d2 > 0) flipButton(ch, d1)
    return
  }
  if (type !== 0x90 || d2 === 0) return // presses only
  // mkII grid: notes 0..39 on channel 0, 8 per row, row 0 at the bottom
  if (ch === 0 && d1 < ROWS * COLS) {
    return launchClip(trackOffset + (d1 % COLS), sceneOffset + (ROWS - 1 - Math.floor(d1 / COLS)))
  }
  if (d1 === N_CLIP_STOP) {
    const t = cols()[trackOffset + ch]
    return t && call('launcher.stop', { track: t.track })
  }
  if (d1 === N_STOP_ALL) return call('launcher.stop', {})
  if (d1 >= N_SCENE_1 && d1 < N_SCENE_1 + ROWS) return call('launcher.scene', { row: sceneOffset + (d1 - N_SCENE_1) + 1 })
  if (d1 === N_PAN) return setKnobMode({ ...knobMode, kind: 'pan' })
  if (d1 === N_SENDS) {
    if (knobMode.kind === 'send') return setKnobMode({ ...knobMode, send: (knobMode.send + 1) % sendCount })
    return setKnobMode({ ...knobMode, kind: 'send', send: 0 })
  }
  if (d1 === N_USER) {
    if (knobMode.kind === 'user') return
    return setKnobMode({ ...knobMode, kind: 'user' })
  }
  if (d1 === N_PLAY) return call('transport.set', { playing: !transport.playing })
  if (d1 === N_STOP) return call('transport.set', { playing: false })
  if (d1 === N_UP) return scroll(0, -1)
  if (d1 === N_DOWN) return scroll(0, 1)
  if (d1 === N_LEFT) return scroll(-1, 0)
  if (d1 === N_RIGHT) return scroll(1, 0)
  if (d1 === N_RECORD || d1 === N_SESSION) {
    const on = !isRecording()
    transport.record = on ? { state: 'recording' } : undefined
    renderButtons()
    return call('transport.set', { record: on })
  }
  if (d1 === N_BANK) return browse()
  if (d1 === N_BANK_LEFT) return setBankPage(bankPage - 1)
  if (d1 === N_BANK_RIGHT) return setBankPage(bankPage + 1)
  if (d1 === N_DEV_LEFT) return stepModule(-1)
  if (d1 === N_DEV_RIGHT) return stepModule(1)
  if (d1 === N_DEV_ONOFF) return toggleModule()
  if (d1 === N_METRONOME) {
    transport.click = !transport.click
    renderButtons()
    return call('transport.set', { click: transport.click })
  }
  if (d1 === N_QUANTIZE) {
    const next = QUANTIZES[(QUANTIZES.indexOf(transport.quantize) + 1) % QUANTIZES.length]
    return call('transport.set', { quantize: next })
  }
  if (d1 === N_UNDO) return call('history.undo', {})
  if (d1 === N_REDO) return call('history.redo', {})
  if (d1 === N_TAP) return tapTempo()
  if (d1 === N_MASTER) {
    selected = new Set(['out'])
    renderButtons()
    return call('selection.select', { addresses: ['out'] }).then(() => setTimeout(pollButtons, 80))
  }
  if (d1 === N_TRACK_SELECT) return

}

function launchClip(trackIndex, slotIndex) {
  const t = cols()[trackIndex]
  if (!t) return
  const slot = t.slots[slotIndex]
  if (!slot || slot === 'empty' || slot === 'recordReady') return
  return call('launcher.launch', { track: t.track, slot: slotIndex + 1 })
}

function scroll(dx, dy) {
  const maxSlots = Math.max(0, ...state.tracks.map((t) => t.slots.length))
  trackOffset = Math.max(0, Math.min(Math.max(0, cols().length - COLS), trackOffset + dx * COLS))
  sceneOffset = Math.max(0, Math.min(Math.max(0, maxSlots - ROWS), sceneOffset + dy * ROWS))
  render()
  renderKnobs()
  renderButtons()
  applyKnobMaps()
}

// ---------------------------------------------------------------- LEDs

let blinkOn = true
let phase = 0

function slotColor(s) {
  switch (s) {
    case 'playing':
      return C_GREEN
    case 'queued':
    case 'stopping':
      return blinkOn ? C_GREEN : C_OFF
    case 'stopped':
      return C_AMBER
    default:
      return C_OFF
  }
}

function render() {
  if (!output) return
  const connected = !!sock
  for (let c = 0; c < COLS; c++) {
    const t = connected ? cols()[trackOffset + c] : undefined
    for (let r = 0; r < ROWS; r++) {
      const slot = t ? t.slots[sceneOffset + r] : undefined
      const color = slotColor(slot)
      const note = (ROWS - 1 - r) * COLS + c
      const key = `pad${note}`
      if (ledCache.get(key) !== color) {
        ledCache.set(key, color)
        output.sendMessage([0x90, note, color])
      }
    }
    const playing = t && typeof t.playing === 'object'
    ledCol(N_CLIP_STOP, c, playing ? 1 : 0)
  }
  for (let r = 0; r < ROWS; r++) {
    const row = sceneOffset + r
    const on = connected && cols().some((t) => t.slots[row] && t.slots[row] !== 'empty' && t.slots[row] !== 'recordReady')
    ledCol(N_SCENE_1 + r, 0, on ? 1 : 0)
  }
  ledCol(N_PLAY, 0, transport.playing ? 1 : 0)
  ledCol(N_STOP, 0, !transport.playing && connected ? 1 : 0)
  ledCol(N_UP, 0, sceneOffset > 0 ? 1 : 0)
  ledCol(N_LEFT, 0, trackOffset > 0 ? 1 : 0)
}

setInterval(() => {
  phase++
  blinkOn = phase % 4 < 2
  render()
}, 200)

// Single-colour buttons: velocity 0 = off, 1 = on, on their own channel
function ledCol(note, channel, value) {
  const key = `${note}/${channel}`
  if (ledCache.get(key) === value) return
  ledCache.set(key, value)
  if (output) output.sendMessage([0x90 | channel, note, value])
}

// ---------------------------------------------------------------- main

openKnobsPort()
connectPatches()
// The bridge lives as long as Patches does: it quits once the daemon has been gone for a while
// (30 s to find it at start, 10 s after it is lost).
let lastSeen = Date.now()
let everConnected = false
setInterval(() => {
  if (sock) {
    lastSeen = Date.now()
    everConnected = true
    return
  }
  if (Date.now() - lastSeen > (everConnected ? 10000 : 30000)) {
    log('Patches is not running, quitting')
    bye()
  }
  connectPatches()
}, 2000)

setInterval(() => {
  if (!input) {
    openApc()
    return
  }
  // Notice an unplugged controller
  const probe = new midi.Input()
  const present = findPort(probe, APC_PORT) >= 0
  probe.closePort?.()
  if (!present) closeApc('disconnected')
}, 2000)
openApc()

const bye = () => {
  closeApc()
  process.exit(0)
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
