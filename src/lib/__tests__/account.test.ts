import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api';

/**
 * Account lifecycle: creating, deleting, and creating again with the same
 * address.
 *
 * Accounts live in this device's localStorage, so "delete" is a soft delete —
 * the row stays so that goals and audit entries pointing at it do not dangle,
 * but the address has to become reusable. Getting that wrong strands someone
 * out of their own email address forever, with no way back short of clearing
 * site data.
 */

beforeEach(() => {
  localStorage.clear();
});

const EMAIL = 'person@example.com';

describe('deleting an account frees its email', () => {
  it('lets the same address register again', async () => {
    const first = await api.register('Janek', EMAIL, 'pass1234');
    expect(first.email).toBe(EMAIL);

    await api.deleteAccount(first.id);

    // The whole point: the address is free again.
    const second = await api.register('Janek Again', EMAIL, 'pass5678');
    expect(second.email).toBe(EMAIL);
    // A genuinely new account, not the old one resurrected.
    expect(second.id).not.toBe(first.id);
  });

  it('refuses a second live account on one address', async () => {
    await api.register('Janek', EMAIL, 'pass1234');
    await expect(api.register('Impostor', EMAIL, 'other123')).rejects.toThrow(/already exists/i);
  });

  it('normalises case and spacing, so one address cannot be registered twice', async () => {
    await api.register('Janek', EMAIL, 'pass1234');
    await expect(api.register('Janek', `  ${EMAIL.toUpperCase()} `, 'pass1234')).rejects.toThrow(
      /already exists/i,
    );
  });

  it('will not log in to a deleted account, with the old password or a new one', async () => {
    const user = await api.register('Janek', EMAIL, 'pass1234');
    await api.deleteAccount(user.id);

    await expect(api.login(EMAIL, 'pass1234')).rejects.toThrow(/invalid email or password/i);

    // …and after re-registering, only the NEW password works.
    await api.register('Janek Again', EMAIL, 'pass5678');
    await expect(api.login(EMAIL, 'pass1234')).rejects.toThrow(/invalid email or password/i);
    await expect(api.login(EMAIL, 'pass5678')).resolves.toMatchObject({ email: EMAIL });
  });

  it('sets a new password for an address, and the old one stops working', async () => {
    await api.register('Janek', EMAIL, 'oldpass123');

    await api.setPasswordForEmail(EMAIL, 'newpass456');

    await expect(api.login(EMAIL, 'oldpass123')).rejects.toThrow(/invalid email or password/i);
    await expect(api.login(EMAIL, 'newpass456')).resolves.toMatchObject({ email: EMAIL });
  });

  it('refuses to set a password for an address this device has no account for', async () => {
    await expect(api.setPasswordForEmail('stranger@example.com', 'whatever12')).rejects.toThrow(
      /no Pactista account for that address on this device/i,
    );
  });

  it('will not resurrect a deleted account through a password reset', async () => {
    const user = await api.register('Janek', EMAIL, 'oldpass123');
    await api.deleteAccount(user.id);

    await expect(api.setPasswordForEmail(EMAIL, 'newpass456')).rejects.toThrow(/no Pactista account/i);
  });

  it('survives a delete/register cycle repeated several times', async () => {
    for (let i = 0; i < 3; i += 1) {
      const u = await api.register(`Janek ${i}`, EMAIL, `pass${i}0000`);
      expect(u.email).toBe(EMAIL);
      await api.deleteAccount(u.id);
    }
    // Still free after the last delete.
    await expect(api.register('Janek final', EMAIL, 'passfinal')).resolves.toMatchObject({
      email: EMAIL,
    });
  });
});
