import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hash = (token) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => { throw new AppError(status, message); };
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (length) => Array.from(randomBytes(length), (byte) => codeAlphabet[byte % codeAlphabet.length]).join('');
const sameHash = (expected, actual) => {
  const digest = typeof expected === 'string' && /^[a-f0-9]{64}$/i.test(expected) ? expected : '0'.repeat(64);
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(actual, 'hex'));
};

function textField(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') fail(400, `${label} må være tekst.`);
  const clean = value.trim().normalize('NFC');
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) {
    fail(400, `${label} må inneholde mellom 1 og ${max} tegn.`);
  }
  return clean;
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'app.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_hash TEXT NOT NULL,
      host_code_hash TEXT,
      host_code_generation INTEGER NOT NULL DEFAULT 0,
      active_beer_id TEXT,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS beers (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brewery TEXT NOT NULL,
      abv REAL,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_code, name_key)
    );
    CREATE TABLE IF NOT EXISTS scores (
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      beer_id TEXT NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(participant_id, beer_id)
    );
    CREATE TABLE IF NOT EXISTS beer_images (
      beer_id TEXT PRIMARY KEY REFERENCES beers(id) ON DELETE CASCADE,
      data BLOB NOT NULL,
      content_type TEXT NOT NULL,
      version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_tokens (
      token_hash TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS beers_session ON beers(session_code);
    CREATE INDEX IF NOT EXISTS participants_session ON participants(session_code);
    CREATE INDEX IF NOT EXISTS scores_beer ON scores(beer_id);
    CREATE INDEX IF NOT EXISTS admin_tokens_session ON admin_tokens(session_code);
  `);
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
  if (!sessionColumns.includes('revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.includes('host_code_hash')) db.exec('ALTER TABLE sessions ADD COLUMN host_code_hash TEXT');
  if (!sessionColumns.includes('host_code_generation')) db.exec('ALTER TABLE sessions ADD COLUMN host_code_generation INTEGER NOT NULL DEFAULT 0');

  function getSessionRow(code) {
    const row = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
    if (!row) fail(404, 'Fant ikke smakingen. Kontroller koden.');
    return row;
  }

  function session(code) {
    const row = getSessionRow(code);
    const beers = db.prepare(`
      SELECT b.id, b.name, b.brewery, b.abv, b.position AS "order",
        COUNT(s.score) AS scoreCount, COALESCE(SUM(s.score), 0) AS totalScore,
        AVG(s.score) AS averageScore, i.version AS imageVersion
      FROM beers b LEFT JOIN scores s ON s.beer_id = b.id
      LEFT JOIN beer_images i ON i.beer_id = b.id
      WHERE b.session_code = ? GROUP BY b.id ORDER BY b.position, b.id
    `).all(code).map(({ imageVersion, ...beer }) => ({
      ...beer,
      imageUrl: imageVersion ? `/api/sessions/${code}/beers/${beer.id}/image?v=${imageVersion}` : null,
    }));
    const participants = db.prepare(`
      SELECT p.id, p.name, CASE WHEN s.score IS NULL THEN 0 ELSE 1 END AS hasScored,
        COUNT(history.score) AS scoreCount, COALESCE(SUM(history.score), 0) AS totalScore,
        AVG(history.score) AS averageScore
      FROM participants p LEFT JOIN scores s ON s.participant_id = p.id AND s.beer_id = ?
      LEFT JOIN scores history ON history.participant_id = p.id
      WHERE p.session_code = ? GROUP BY p.id ORDER BY p.created_at, p.rowid
    `).all(row.active_beer_id, code).map((r) => ({ ...r, hasScored: Boolean(r.hasScored) }));
    const scoredCount = participants.filter((p) => p.hasScored).length;
    const groupScoreCount = beers.reduce((sum, beer) => sum + beer.scoreCount, 0);
    const groupTotalScore = beers.reduce((sum, beer) => sum + beer.totalScore, 0);
    return {
      code: row.code,
      name: row.name,
      createdAt: row.created_at,
      revision: row.revision,
      hostCodeGeneration: row.host_code_generation,
      activeBeerId: row.active_beer_id,
      beers,
      participants,
      participantCount: participants.length,
      scoredCount,
      missingCount: row.active_beer_id ? participants.length - scoredCount : 0,
      groupAverageScore: groupScoreCount ? groupTotalScore / groupScoreCount : null,
      groupScoreCount,
    };
  }

  function authenticate(code, supplied) {
    const row = getSessionRow(code);
    if (typeof supplied !== 'string' || supplied.length < 20 || supplied.length > 200) {
      fail(401, 'Du må logge inn på smakingen på nytt.');
    }
    const digest = hash(supplied);
    if (sameHash(row.admin_hash, digest) || db.prepare('SELECT 1 FROM admin_tokens WHERE session_code = ? AND token_hash = ?').get(code, digest)) return { role: 'admin' };
    const participant = db.prepare('SELECT id FROM participants WHERE session_code = ? AND token_hash = ?').get(code, digest);
    if (!participant) fail(401, 'Tilgangen er ugyldig. Bli med på smakingen på nytt.');
    return { role: 'participant', participantId: participant.id };
  }

  function admin(code, supplied) {
    const identity = authenticate(code, supplied);
    if (identity.role !== 'admin') fail(403, 'Bare arrangøren kan gjøre dette.');
  }

  function beerInSession(code, id) {
    const beer = typeof id === 'string' && db.prepare('SELECT * FROM beers WHERE id = ? AND session_code = ?').get(id, code);
    if (!beer) fail(404, 'Fant ikke ølet i denne smakingen.');
    return beer;
  }

  function authorizeBeerImage(code, supplied, id) {
    admin(code, supplied);
    beerInSession(code, id);
  }

  function change(code, write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const extra = write() ?? {};
      db.prepare('UPDATE sessions SET revision = revision + 1 WHERE code = ?').run(code);
      const result = { ...extra, session: session(code) };
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    session,
    authenticate,
    authorizeBeerImage,
    generateHostCode(code, supplied) {
      admin(code, supplied);
      const oldHash = getSessionRow(code).host_code_hash;
      let hostCode;
      do { hostCode = randomCode(8); } while (oldHash === hash(hostCode));
      return change(code, () => {
        db.prepare('UPDATE sessions SET host_code_hash = ?, host_code_generation = host_code_generation + 1 WHERE code = ?').run(hash(hostCode), code);
        return { hostCode };
      });
    },
    hostLogin(code, input) {
      const supplied = typeof input.hostCode === 'string' && input.hostCode.length <= 100
        ? input.hostCode.replace(/[\s-]/gu, '').toUpperCase() : '';
      const validFormat = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(supplied);
      const adminToken = token();
      return change(code, () => {
        const row = getSessionRow(code);
        const matches = sameHash(row.host_code_hash, hash(supplied));
        if (!validFormat || !row.host_code_hash || !matches) fail(401, 'Vertskoden er feil. Kontroller koden og prøv igjen.');
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM admin_tokens WHERE session_code = ?').get(code);
        if (count >= 100) fail(409, 'Smakingen har nådd grensen på 100 ekstra vertsenheter.');
        db.prepare('INSERT INTO admin_tokens(token_hash, session_code, created_at) VALUES (?, ?, ?)').run(hash(adminToken), code, new Date().toISOString());
        return { adminToken };
      });
    },
    beerImage(code, id) {
      getSessionRow(code);
      beerInSession(code, id);
      const image = db.prepare('SELECT data, content_type AS contentType, version FROM beer_images WHERE beer_id = ?').get(id);
      if (!image) fail(404, 'Dette ølet har ikke noe bilde ennå.');
      return { ...image, data: Buffer.from(image.data) };
    },
    setBeerImage(code, supplied, id, data) {
      authorizeBeerImage(code, supplied, id);
      return change(code, () => {
        db.prepare(`INSERT INTO beer_images(beer_id, data, content_type, version) VALUES (?, ?, ?, ?)
          ON CONFLICT(beer_id) DO UPDATE SET data = excluded.data, content_type = excluded.content_type, version = excluded.version`)
          .run(id, data, 'image/webp', randomUUID());
      });
    },
    deleteBeerImage(code, supplied, id) {
      authorizeBeerImage(code, supplied, id);
      return change(code, () => { db.prepare('DELETE FROM beer_images WHERE beer_id = ?').run(id); });
    },
    create(input) {
      const name = textField(input.name, 'Navnet på smakingen', 80);
      const adminToken = token();
      let code;
      do {
        code = randomCode(6);
      } while (db.prepare('SELECT 1 FROM sessions WHERE code = ?').get(code));
      db.prepare('INSERT INTO sessions(code, name, admin_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(code, name, hash(adminToken), new Date().toISOString());
      return { code, adminToken, session: session(code) };
    },
    join(code, input) {
      getSessionRow(code);
      const name = textField(input.name, 'Navnet ditt', 40);
      const nameKey = name.normalize('NFKC').toLocaleLowerCase('nb-NO');
      if (db.prepare('SELECT 1 FROM participants WHERE session_code = ? AND name_key = ?').get(code, nameKey)) {
        fail(409, 'Navnet er allerede i bruk. Velg et annet navn.');
      }
      const count = db.prepare('SELECT COUNT(*) AS count FROM participants WHERE session_code = ?').get(code).count;
      if (count >= 100) fail(409, 'Smakingen har nådd grensen på 100 deltakere.');
      const participantToken = token();
      const participantId = randomUUID();
      return change(code, () => {
        db.prepare('INSERT INTO participants(id, session_code, name, name_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(participantId, code, name, nameKey, hash(participantToken), new Date().toISOString());
        return { participantToken, participantId };
      });
    },
    me(code, supplied) {
      const identity = authenticate(code, supplied);
      if (identity.role === 'admin') return identity;
      const scores = {};
      for (const row of db.prepare('SELECT beer_id, score FROM scores WHERE participant_id = ?').all(identity.participantId)) {
        scores[row.beer_id] = row.score;
      }
      return { ...identity, scores };
    },
    addBeer(code, supplied, input) {
      admin(code, supplied);
      const name = textField(input.name, 'Ølnavnet', 100);
      const brewery = textField(input.brewery, 'Bryggeriet', 80, true);
      let abv = null;
      if (input.abv !== undefined && input.abv !== null && input.abv !== '') {
        if (typeof input.abv !== 'number' || !Number.isFinite(input.abv) || input.abv < 0 || input.abv > 100) {
          fail(400, 'Alkoholprosenten må være et tall mellom 0 og 100.');
        }
        abv = input.abv;
      }
      const { count, position } = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(position), 0) + 1 AS position FROM beers WHERE session_code = ?').get(code);
      if (count >= 100) fail(409, 'Du kan legge til maksimalt 100 øl i én smaking.');
      const beerId = randomUUID();
      return change(code, () => {
        db.prepare('INSERT INTO beers(id, session_code, name, brewery, abv, position) VALUES (?, ?, ?, ?, ?, ?)')
          .run(beerId, code, name, brewery, abv, position);
        return { beerId };
      });
    },
    deleteBeer(code, supplied, id) {
      admin(code, supplied);
      beerInSession(code, id);
      if (getSessionRow(code).active_beer_id === id || db.prepare('SELECT 1 FROM scores WHERE beer_id = ?').get(id)) {
        fail(409, 'Øl som smakes nå eller har fått poeng, kan ikke slettes.');
      }
      return change(code, () => { db.prepare('DELETE FROM beers WHERE id = ?').run(id); });
    },
    openRound(code, supplied, input) {
      admin(code, supplied);
      beerInSession(code, input.beerId);
      return change(code, () => { db.prepare('UPDATE sessions SET active_beer_id = ? WHERE code = ?').run(input.beerId, code); });
    },
    closeRound(code, supplied) {
      admin(code, supplied);
      return change(code, () => { db.prepare('UPDATE sessions SET active_beer_id = NULL WHERE code = ?').run(code); });
    },
    score(code, supplied, input) {
      const identity = authenticate(code, supplied);
      if (identity.role !== 'participant') fail(403, 'Bli med som deltaker for å gi poeng.');
      const row = getSessionRow(code);
      if (!row.active_beer_id) fail(409, 'Ingen øl er åpent for poeng akkurat nå.');
      if (input.beerId !== undefined && input.beerId !== row.active_beer_id) {
        fail(409, 'Arrangøren har byttet øl. Last inn det nye ølet før du gir poeng.');
      }
      if (!Number.isInteger(input.score) || input.score < 1 || input.score > 10) {
        fail(400, 'Velg et helt antall poeng fra 1 til 10.');
      }
      return change(code, () => {
        db.prepare(`INSERT INTO scores(participant_id, beer_id, score, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(participant_id, beer_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`)
          .run(identity.participantId, row.active_beer_id, input.score, new Date().toISOString());
      });
    },
    close() { db.close(); },
  };
}
