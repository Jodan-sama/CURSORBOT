import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'dashboard_auth';

async function expectedCookieValue(): Promise<string> {
  const secret = process.env.DASHBOARD_PASSWORD;
  if (!secret) return '';
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/login' || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }
  const expected = await expectedCookieValue();
  if (!expected) {
    return NextResponse.next();
  }
  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (cookie === expected) {
    return NextResponse.next();
  }
  const login = new URL('/login', request.url);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
