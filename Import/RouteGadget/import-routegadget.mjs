// Imports every GEOREFERENCED map + its courses from your RouteGedget server into a dedicated new club
// on Checkpoint. Run with: node import-routegadget.mjs
//
// Source data model:
//   GET  rg2api.php?type=maps            -> [{mapid, name, georeferenced}]
//   GET  rg2api.php?type=events          -> [{id, mapid, name, club, A..F, ...}]
//     A-F are a standard 6-parameter affine transform, confirmed to already be
//     in WGS84 decimal degrees (not a projected grid -- there's a second
//     localA-F set for that, in OSGB36 Easting/Northing, which we don't use):
//       lon = A*px + B*py + C
//       lat = D*px + E*py + F
//     Only present on the event record when P.mapid is georeferenced -- absent
//     otherwise. Several events can share one mapid (re-run on the same map).
//   GET  rg2api.php?type=event&id=<id>   -> {courses:[{name,codes,xpos,ypos}]}
//     codes[0] is always "STA<n>", codes[last] "FIN<n>", everything between is
//     a plain control code. xpos/ypos are pixel coordinates on the map image.
//   Map image: https://www.bl.routegadget.co.uk/kartat/<mapid>.<ext>
//     (ext from the map/event record's mapfilename/suffix; falls back to jpg
//     then gif then png, matching the frontend's own fallback logic).
//
// Checkpoint has no notion of the affine transform itself -- POST /api/maps
// wants the image's four corners in real lat/lon (TL,TR,BR,BL, image-space
// order). We get the image's pixel dimensions by downloading it and reading
// the header ourselves (no imaging library needed for GIF/JPEG), then run all
// four corners through the same transform as the controls.

const BL_BASE = 'https://www.bl.routegadget.co.uk/rg2/rg2api.php'
const BL_MAPS_URL = 'https://www.bl.routegadget.co.uk/kartat/'
const CP_API = 'https://api.checkpointrun.com'
const DEFAULT_RADIUS_METERS = 15 // matches CourseInteropEndpoints.DefaultRadiusMeters

const IMPORT_EMAIL = 'your-checkpoint@email.here'
const IMPORT_PASSWORD = 'your-checkpoint-password-here'
const CLUB_NAME = 'Your Orienteering Club Name'
const CLUB_DESCRIPTION = `Maps and courses imported from RouteGadget. Imported ${new Date().toISOString().slice(0, 10)}.`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jget(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

// ---- minimal image-dimension readers (no deps) ----
function gifDims(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}
function jpegDims(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry width/height at
    // the same offset; skip the standalone markers that carry no length field.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5)
      const width = buf.readUInt16BE(i + 7)
      return { width, height }
    }
    const len = buf.readUInt16BE(i + 2)
    i += 2 + len
  }
  return null
}
function imageDims(buf) {
  return gifDims(buf) ?? jpegDims(buf) ?? (() => { throw new Error('Unrecognized image format (expected GIF or JPEG)') })()
}

// ---- affine transform ----
function toLatLon(coeffs, px, py) {
  const lon = coeffs.A * px + coeffs.B * py + coeffs.C
  const lat = coeffs.D * px + coeffs.E * py + coeffs.F
  return { lat, lon }
}

// ---- Checkpoint session (cookie-based, same as MapIdentityApi) ----
class CheckpointSession {
  cookie = ''
  async register() {
    const res = await fetch(`${CP_API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: IMPORT_EMAIL, password: IMPORT_PASSWORD }),
    })
    if (!res.ok && res.status !== 400) throw new Error(`register -> ${res.status}: ${await res.text()}`)
    if (res.status === 400) console.log('  (account already exists -- continuing to login)')
  }
  async login() {
    const res = await fetch(`${CP_API}/login?useCookies=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: IMPORT_EMAIL, password: IMPORT_PASSWORD }),
    })
    if (!res.ok) throw new Error(`login -> ${res.status}: ${await res.text()}`)
    this.cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    if (!this.cookie) throw new Error('login succeeded but no session cookie was returned')
  }
  async json(method, path, body) {
    await sleep(700) // stay well under the 100 req/min global rate limit
    const res = await fetch(`${CP_API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }
  async uploadMap({ file, filename, name, clubId, corners }) {
    await sleep(700)
    const form = new FormData()
    form.set('file', new Blob([file]), filename)
    form.set('name', name)
    form.set('clubId', clubId)
    form.set('tlLat', String(corners.tl.lat)); form.set('tlLon', String(corners.tl.lon))
    form.set('trLat', String(corners.tr.lat)); form.set('trLon', String(corners.tr.lon))
    form.set('brLat', String(corners.br.lat)); form.set('brLon', String(corners.br.lon))
    form.set('blLat', String(corners.bl.lat)); form.set('blLon', String(corners.bl.lon))
    const res = await fetch(`${CP_API}/api/maps`, { method: 'POST', headers: { Cookie: this.cookie }, body: form })
    const text = await res.text()
    if (!res.ok) throw new Error(`POST /api/maps -> ${res.status}: ${text}`)
    return JSON.parse(text)
  }
}

async function fetchMapImage(mapid, mapfilenameHint) {
  const candidates = []
  if (mapfilenameHint) candidates.push(mapfilenameHint)
  candidates.push(`${mapid}.jpg`, `${mapid}.gif`, `${mapid}.png`)
  for (const name of [...new Set(candidates)]) {
    const res = await fetch(BL_MAPS_URL + name)
    if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), filename: name }
  }
  throw new Error(`no map image found for mapid ${mapid} (tried ${candidates.join(', ')})`)
}

async function main() {
  console.log('== Fetching RG data ==')
  const [mapsResp, eventsResp] = await Promise.all([
    jget(`${BL_BASE}?type=maps`),
    jget(`${BL_BASE}?type=events`),
  ])
  const mapMeta = new Map(mapsResp.data.maps.map((m) => [m.mapid, m])) // mapid -> {name, mapfilename, georeferenced}
  const georefEvents = eventsResp.data.events.filter((e) => e.A !== undefined)
  console.log(`  ${mapsResp.data.maps.filter((m) => m.georeferenced).length} maps flagged georeferenced`)
  console.log(`  ${georefEvents.length} events carry an affine transform`)

  // Group by mapid: one physical map can have been (re)used across several events.
  const byMap = new Map()
  for (const ev of georefEvents) {
    if (!byMap.has(ev.mapid)) {
      byMap.set(ev.mapid, {
        mapid: ev.mapid,
        name: mapMeta.get(ev.mapid)?.name || ev.name,
        coeffs: { A: ev.A, B: ev.B, C: ev.C, D: ev.D, E: ev.E, F: ev.F },
        events: [],
      })
    }
    byMap.get(ev.mapid).events.push({ id: ev.id, name: ev.name })
  }
  console.log(`  -> ${byMap.size} distinct georeferenced maps to import`)

  console.log('\n== Setting up the Checkpoint account + club ==')
  const session = new CheckpointSession()
  await session.register()
  await session.login()
  console.log(`  logged in as ${IMPORT_EMAIL}`)
  // Idempotent: a retried run must not create a second club.
  const existing = await session.json('GET', `/api/clubs?q=${encodeURIComponent(CLUB_NAME)}`)
  let club = existing?.items?.find((c) => c.name === CLUB_NAME)
  if (club) {
    console.log(`  reusing existing club: ${club.id}`)
  } else {
    club = await session.json('POST', '/api/clubs', {
      Name: CLUB_NAME,
      DescriptionI18n: { en: CLUB_DESCRIPTION },
      Visibility: 'Public',
    })
    console.log(`  club created: ${club.id}`)
  }

  const results = { club, maps: [], courses: [], skipped: [], errors: [] }

  for (const entry of byMap.values()) {
    process.stdout.write(`\n[map ${entry.mapid}] ${entry.name} ... `)
    try {
      const mapfilenameHint = mapMeta.get(entry.mapid)?.mapfilename
      const { buf, filename } = await fetchMapImage(entry.mapid, mapfilenameHint)
      const { width, height } = imageDims(buf)
      const corners = {
        tl: toLatLon(entry.coeffs, 0, 0),
        tr: toLatLon(entry.coeffs, width, 0),
        br: toLatLon(entry.coeffs, width, height),
        bl: toLatLon(entry.coeffs, 0, height),
      }
      const created = await session.uploadMap({
        file: buf, filename, name: entry.name, clubId: club.id, corners,
      })
      results.maps.push({ mapid: entry.mapid, checkpointMapId: created.id, name: entry.name })
      process.stdout.write(`uploaded (${width}x${height}) -> map ${created.id}\n`)

      // Courses: aggregate across every event that used this map.
      for (const ev of entry.events) {
        const eventDetail = await jget(`${BL_BASE}?type=event&id=${ev.id}`)
        await sleep(300)
        for (const course of eventDetail.data.courses ?? []) {
          const codes = course.codes ?? []
          if (codes.length < 3) {
            results.skipped.push({ event: ev.name, course: course.name, reason: 'no intermediate controls' })
            continue
          }
          const checkPoints = codes.map((code, i) => {
            const { lat, lon } = toLatLon(entry.coeffs, course.xpos[i], course.ypos[i])
            const isStart = i === 0
            const isFinish = i === codes.length - 1
            return {
              Title: isStart ? 'Start' : isFinish ? 'Finish' : code,
              Code: isStart || isFinish ? null : code,
              Order: i,
              Lat: lat, Lon: lon,
              RadiusMeters: DEFAULT_RADIUS_METERS,
              Points: null,
              Type: isStart ? 'Start' : isFinish ? 'Finish' : 'Control',
            }
          })
          try {
            const createdCourse = await session.json('POST', '/api/courses', {
              Name: `${ev.name} - ${course.name}`,
              ClubOwnerId: club.id,
              MapId: created.id,
              Type: 'Line',
              CheckPoints: checkPoints,
              Visibility: 'Public',
            })
            results.courses.push({ event: ev.name, course: course.name, checkpointCourseId: createdCourse.id })
            process.stdout.write(`    course "${ev.name} - ${course.name}" -> ${createdCourse.id}\n`)
          } catch (err) {
            results.errors.push({ stage: 'course', event: ev.name, course: course.name, error: String(err) })
            process.stdout.write(`    course "${ev.name} - ${course.name}" FAILED: ${err}\n`)
          }
        }
      }
    } catch (err) {
      results.errors.push({ stage: 'map', mapid: entry.mapid, name: entry.name, error: String(err) })
      process.stdout.write(`FAILED: ${err}\n`)
    }
  }

  const fs = await import('node:fs')
  const logPath = new URL('./import-result.json', import.meta.url)
  fs.writeFileSync(logPath, JSON.stringify(results, null, 2))

  console.log('\n== Summary ==')
  console.log(`Club:    https://checkpointrun.com/clubs/${club.id} (or via app: /app/clubs/${club.id})`)
  console.log(`Maps:    ${results.maps.length} created`)
  console.log(`Courses: ${results.courses.length} created, ${results.skipped.length} skipped, ${results.errors.length} errors`)
  console.log(`Full log written to: ${logPath.pathname}`)
  console.log(`\nImport account: ${IMPORT_EMAIL} / ${IMPORT_PASSWORD}`)
  console.log('(club owner is Admin -- log in and change the password, or transfer ownership, as you see fit)')
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1) })
