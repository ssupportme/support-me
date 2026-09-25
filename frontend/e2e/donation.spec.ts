import { test, expect } from '@playwright/test';
import { setupE2EMocks } from './fixtures/test-mocks';

test.describe('Donation Flow', () => {
  test('user can connect wallet and send a one-time donation', async ({ page }) => {
    await setupE2EMocks(page);

    // 1. Visit creator profile
    await page.goto('/alice');

    // 2. Connect wallet on donation card
    const connectBtn = page.getByRole('button', { name: 'Connect Wallet' });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // 3. Verify connected balance banner is shown
    await expect(page.getByText(/Wallet: GDHJ/i)).toBeVisible();
    await expect(page.getByText('150.0000 XLM')).toBeVisible();

    // 4. Select amount preset "10"
    const preset10Btn = page.getByRole('button', { name: '10', exact: true });
    await expect(preset10Btn).toBeVisible();
    await preset10Btn.click();

    const amountInput = page.locator('#donation-amount');
    await expect(amountInput).toHaveValue('10');

    // 5. Add custom message
    const messageInput = page.locator('#donation-message');
    await messageInput.fill('Keep building awesome tools!');
    await expect(page.getByText('28/140')).toBeVisible();

    // 6. Submit donation
    const sendBtn = page.getByRole('button', { name: 'Send Donation' });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 7. Verify success toast notification
    await expect(page.getByText('Donation sent successfully!')).toBeVisible({ timeout: 10000 });

    // 8. Verify form resets to defaults
    await expect(amountInput).toHaveValue('5');
    await expect(messageInput).toHaveValue('');
  });

  test('displays error toast when donation transaction fails', async ({ page }) => {
    await setupE2EMocks(page, {
      shouldFailDonation: true,
      donationErrorMessage: 'Insufficient funds on account',
    });

    await page.goto('/alice');

    // Connect wallet
    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await expect(page.getByText(/Wallet:/i)).toBeVisible();

    // Click Send Donation
    const sendBtn = page.getByRole('button', { name: 'Send Donation' });
    await sendBtn.click();

    // Verify error notification
    await expect(page.getByText('Donation failed')).toBeVisible({ timeout: 10000 });
  });
});
