import { IsWalletAddressConstraint } from './is-wallet-address.validator';

describe('IsWalletAddressConstraint', () => {
  const validator = new IsWalletAddressConstraint();

  it('accepts valid EVM, Solana, and TON addresses', () => {
    expect(
      validator.validate('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    ).toBe(true);
    expect(
      validator.validate('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'),
    ).toBe(true);
    expect(
      validator.validate('EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'),
    ).toBe(true);
  });

  it('rejects invalid wallet addresses', () => {
    expect(validator.validate('not-a-wallet')).toBe(false);
    expect(validator.validate('0x123')).toBe(false);
    expect(validator.validate('')).toBe(false);
  });
});
