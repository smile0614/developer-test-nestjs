import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidTonAddress,
} from '../address.utils';

/**
 * Custom class-validator constraint for EVM/Solana/TON addresses.
 * Network-agnostic — works regardless of the NETWORK env variable.
 */
@ValidatorConstraint({ name: 'isWalletAddress', async: false })
export class IsWalletAddressConstraint implements ValidatorConstraintInterface {
  validate(address: string): boolean {
    return (
      isValidEvmAddress(address) ||
      isValidSolanaAddress(address) ||
      isValidTonAddress(address)
    );
  }

  defaultMessage(): string {
    return (
      'Invalid wallet address — must be a valid EVM (0x...), Solana (base58), or TON address'
    );
  }
}

/** Decorator that validates EVM, Solana, and TON wallet addresses */
export function IsWalletAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsWalletAddressConstraint,
    });
  };
}
