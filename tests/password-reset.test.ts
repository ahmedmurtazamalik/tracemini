import {afterEach, describe, expect, it, vi} from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {openTestDb} from '../apps/server/src/test-db.js';
import {createApp} from '../apps/server/src/app.js';
import type {DB} from '../apps/server/src/db.js';

let db: DB;
afterEach(async () => db && await db.close());

const auth = (token: string) => ({authorization: ['Bearer', token].join(' ')});

async function setup(deliverPasswordReset: (delivery: {email: string; resetUrl: string; expiresAt: string}) => Promise<void>) {
  db = await openTestDb();
  return createApp(db, undefined, undefined, {
    publicOrigin: 'http://localhost:3000',
    deliverPasswordReset,
  });
}

describe('password recovery', () => {
  it('delivers a single-use expiring reset link without revealing whether the account exists', async () => {
    const deliveries: Array<{email: string; resetUrl: string; expiresAt: string}> = [];
    const app = await setup(async delivery => { deliveries.push(delivery); });

    const registered = (await request(app).post('/api/auth/register').send({
      name: 'Reset User',
      email: 'reset@example.test',
      password: 'password123',
    }).expect(201)).body;

    const known = await request(app).post('/api/auth/password-reset/request').send({email: ' RESET@example.test '}).expect(202);
    const unknown = await request(app).post('/api/auth/password-reset/request').send({email: 'missing@example.test'}).expect(202);
    expect(known.body).toEqual(unknown.body);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({email: 'reset@example.test'});
    expect(deliveries[0].resetUrl).toMatch(/^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]+$/);
    expect(new Date(deliveries[0].expiresAt).getTime()).toBeGreaterThan(Date.now());

    const resetToken = new URL(deliveries[0].resetUrl).searchParams.get('token');
    await request(app).post('/api/auth/password-reset/complete').send({token: resetToken, password: 'newpassword123'}).expect(200);
    await request(app).post('/api/auth/password-reset/complete').send({token: resetToken, password: 'anotherpassword123'}).expect(400);
    await request(app).get('/api/auth/me').set(auth(registered.token)).expect(401);
    await request(app).post('/api/auth/login').send({email: 'reset@example.test', password: 'password123'}).expect(401);
    await request(app).post('/api/auth/login').send({email: 'reset@example.test', password: 'newpassword123'}).expect(200);
  });

  it('rejects weak passwords and expired reset tokens', async () => {
    let resetUrl = '';
    const app = await setup(async delivery => { resetUrl = delivery.resetUrl; });
    await request(app).post('/api/auth/register').send({name: 'Expired', email: 'expired@example.test', password: 'password123'}).expect(201);
    await request(app).post('/api/auth/password-reset/request').send({email: 'expired@example.test'}).expect(202);
    const resetToken = new URL(resetUrl).searchParams.get('token');

    await request(app).post('/api/auth/password-reset/complete').send({token: resetToken, password: 'short'}).expect(400);
    await db.prepare("UPDATE password_reset_tokens SET expires_at='2000-01-01T00:00:00.000Z'").run();
    await request(app).post('/api/auth/password-reset/complete').send({token: resetToken, password: 'newpassword123'}).expect(400);
  });

  it('rejects an invalid reset token before password hashing', async () => {
    db = await openTestDb();
    const app = createApp(db, undefined, undefined, {publicOrigin: 'https://trace.example'});
    const hashPassword = vi.spyOn(bcrypt, 'hash');
    try {
      await request(app).post('/api/auth/password-reset/complete').send({token: 'invalid-reset-token', password: 'newpassword123'}).expect(400);
      expect(hashPassword).not.toHaveBeenCalled();
    } finally {
      hashPassword.mockRestore();
    }
  });

  it('does not reveal account existence when reset delivery fails', async () => {
    db = await openTestDb();
    const failingDelivery = {send: async () => { throw new Error('delivery unavailable'); }};
    const app = createApp(db, undefined, undefined, {deliverPasswordReset: failingDelivery.send, publicOrigin: 'https://trace.example'});
    await request(app).post('/api/auth/register').send({name: 'Recovery', email: 'recovery@example.test', password: 'password123'}).expect(201);

    const known = await request(app).post('/api/auth/password-reset/request').send({email: 'recovery@example.test'});
    const unknown = await request(app).post('/api/auth/password-reset/request').send({email: 'missing@example.test'});
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect((await db.prepare('SELECT COUNT(*) count FROM password_reset_tokens').get()).count).toBe(0);
  });

  it('throttles repeated reset delivery without changing the generic response', async () => {
    const deliveries: string[] = [];
    const app = await setup(async delivery => { deliveries.push(delivery.email); });
    await request(app).post('/api/auth/register').send({name: 'Limited', email: 'limited@example.test', password: 'password123'}).expect(201);

    const responses = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      responses.push(await request(app).post('/api/auth/password-reset/request').send({email: 'limited@example.test'}).expect(202));
    }

    expect(new Set(responses.map(response => JSON.stringify(response.body))).size).toBe(1);
    expect(deliveries).toHaveLength(5);
  });

  it('keeps a successfully delivered link valid when an overlapping delivery fails', async () => {
    db = await openTestDb();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    let attempts = 0;
    let firstUrl = '';
    const deliver = async (message: {resetUrl: string}) => {
      attempts++;
      if (attempts === 1) { firstUrl = message.resetUrl; firstEntered(); await release; return; }
      throw new Error('second delivery failed');
    };
    const app = createApp(db, undefined, undefined, {deliverPasswordReset: deliver, publicOrigin: 'https://trace.example'});
    await request(app).post('/api/auth/register').send({name: 'Overlap', email: 'overlap@example.test', password: 'password123'}).expect(201);

    const first = request(app).post('/api/auth/password-reset/request').send({email: 'overlap@example.test'});
    const firstResponse = first.then(response => response);
    await entered;
    await request(app).post('/api/auth/password-reset/request').send({email: 'overlap@example.test'}).expect(202);
    releaseFirst();
    await firstResponse.then(response => expect(response.status).toBe(202));

    const deliveredToken = new URL(firstUrl).searchParams.get('token');
    await request(app).post('/api/auth/password-reset/complete').send({token: deliveredToken, password: 'newpassword123'}).expect(200);
  });

  it('keeps delivered links valid when overlapping deliveries finish out of order', async () => {
    db = await openTestDb();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const delivered: string[] = [];
    let attempts = 0;
    const app = createApp(db, undefined, undefined, {publicOrigin: 'https://trace.example', deliverPasswordReset: async ({resetUrl}) => {
      attempts++;
      if (attempts === 1) { firstEntered(); await release; }
      delivered.push(new URL(resetUrl).searchParams.get('token')!);
    }});
    await request(app).post('/api/auth/register').send({name: 'Overlap', email: 'overlap-success@example.test', password: 'password123'}).expect(201);

    const first = request(app).post('/api/auth/password-reset/request').send({email: 'overlap-success@example.test'});
    const firstResponse = first.then(response => response);
    await entered;
    await request(app).post('/api/auth/password-reset/request').send({email: 'overlap-success@example.test'}).expect(202);
    releaseFirst();
    await firstResponse.then(response => expect(response.status).toBe(202));

    expect(delivered).toHaveLength(2);
    await request(app).post('/api/auth/password-reset/complete').send({token: delivered[1], password: 'newpassword123'}).expect(200);
    await request(app).post('/api/auth/password-reset/complete').send({token: delivered[0], password: 'anotherpassword123'}).expect(400);
  });

  it('invalidates a login that overlaps password reset', async () => {
    let resetUrl = '';
    const app = await setup(async delivery => { resetUrl = delivery.resetUrl; });
    await request(app).post('/api/auth/register').send({name: 'Race', email: 'race@example.test', password: 'password123'}).expect(201);
    await request(app).post('/api/auth/password-reset/request').send({email: 'race@example.test'}).expect(202);
    const resetToken = new URL(resetUrl).searchParams.get('token');

    const originalPrepare = db.prepare.bind(db);
    let releaseInsert!: () => void;
    let insertEntered!: () => void;
    const entered = new Promise<void>(resolve => { insertEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseInsert = resolve; });
    let pauseSessionInsert = true;
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!/^INSERT INTO sessions/i.test(sql)) return statement;
      return {...statement, run: async (...values: any[]) => {
        if (pauseSessionInsert) { pauseSessionInsert = false; insertEntered(); await release; }
        return statement.run(...values);
      }};
    }) as typeof db.prepare;

    const login = request(app).post('/api/auth/login').send({email: 'race@example.test', password: 'password123'});
    const loginResponse = login.then(response => response);
    await entered;
    const resetResponse = request(app).post('/api/auth/password-reset/complete').send({token: resetToken, password: 'newpassword123'});
    await resetResponse.expect(200);
    releaseInsert();
    const loggedIn = await loginResponse;
    await request(app).get('/api/auth/me').set(auth(loggedIn.body.token)).expect(401);
  });

  it('requires a trusted password-reset origin in production', async () => {
    db = await openTestDb();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOrigin = process.env.TRACEMINI_PUBLIC_ORIGIN;
    process.env.NODE_ENV = 'production';
    delete process.env.TRACEMINI_PUBLIC_ORIGIN;
    try {
      expect(() => createApp(db)).toThrow('TRACEMINI_PUBLIC_ORIGIN');
      process.env.TRACEMINI_PUBLIC_ORIGIN = 'https://trace.example/untrusted-path';
      expect(() => createApp(db)).toThrow('origin');
      process.env.TRACEMINI_PUBLIC_ORIGIN = 'http://trace.example';
      expect(() => createApp(db)).toThrow('HTTPS');
      process.env.TRACEMINI_PUBLIC_ORIGIN = 'https://trace.example';
      expect(() => createApp(db)).not.toThrow();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousOrigin === undefined) delete process.env.TRACEMINI_PUBLIC_ORIGIN;
      else process.env.TRACEMINI_PUBLIC_ORIGIN = previousOrigin;
    }
  });
});
