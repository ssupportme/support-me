import { NextResponse } from 'next/server';

export const revalidate = 60;

export async function GET() {
  const key = process.env.COINGECKO_API_KEY;
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=tether,stellar&vs_currencies=ngn';

  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(key ? { 'x-cg-demo-api-key': key } : {}),
      },
      next: { revalidate: 60 },
    });

    if (res.ok) {
      const json = await res.json();
      const ngnPerUsdt = json?.tether?.ngn;
      const ngnPerXlm = json?.stellar?.ngn;
      if (ngnPerUsdt != null && typeof ngnPerUsdt === 'number') {
        return NextResponse.json({
          rate: ngnPerUsdt,
          xlmRate: typeof ngnPerXlm === 'number' ? ngnPerXlm : 165,
          source: 'coingecko',
          timestamp: Date.now(),
        });
      }
    }
  } catch {
    // Fall through to fallback
  }

  return NextResponse.json({ rate: 1380, xlmRate: 165, source: 'fallback', timestamp: Date.now() });
}
