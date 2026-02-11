import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

const COOKIE_NAME = 'dashboard_auth';
const COOKIE_OPTIONS = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400'; // 24h

function authCookieValue(): string {
  const secret = process.env.DASHBOARD_PASSWORD;
  if (!secret) return '';
  return createHash('sha256').update(secret).digest('hex');
}

export async function POST(request: NextRequest) {
  const secret = process.env.DASHBOARD_PASSWORD;
  if (!secret) {
    return NextResponse.json({ error: 'Dashboard auth not configured' }, { status: 500 });
  }
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const password = body.password;
  if (password !== secret) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, authCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 86400,
  });
  return res;
}
