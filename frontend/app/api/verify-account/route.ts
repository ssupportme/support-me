import { NextRequest, NextResponse } from 'next/server';

const MOCK_ACCOUNTS: Record<string, string> = {
  '0123456789': 'John Doe',
  '9876543210': 'Jane Smith',
  '1111111111': 'Test User',
  '2222222222': 'Demo Account',
};

export async function GET(request: NextRequest) {
  const accountNo = request.nextUrl.searchParams.get('accountNo');
  const bank = request.nextUrl.searchParams.get('bank');

  if (!accountNo || !/^\d{10}$/.test(accountNo)) {
    return NextResponse.json({ error: 'Account number must be exactly 10 digits.' }, { status: 400 });
  }
  if (!bank) {
    return NextResponse.json({ error: 'Bank is required.' }, { status: 400 });
  }

  // Simulate network delay for realistic UX
  await new Promise((r) => setTimeout(r, 800));

  const accountName = MOCK_ACCOUNTS[accountNo];
  if (!accountName) {
    return NextResponse.json({ error: 'Account not found. Please check the number and try again.' }, { status: 404 });
  }

  return NextResponse.json({
    accountNo,
    bank,
    accountName,
    resolved: true,
    timestamp: Date.now(),
  });
}
