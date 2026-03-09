import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { WatchWalletDto } from './dto/watch-wallet.dto';
import {
  WalletBalance,
  TransactionList,
  WatchedWalletWithBalance,
  BalanceAlert,
  TokenBalance,
  NftItem,
} from '../blockchain/types/blockchain.types';
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from './events/wallet-balance-changed.event';
import { formatBalance, hasBalanceChanged } from '../utils/decimal.utils';
import { isValidEvmAddress, isValidSolanaAddress } from '../utils/address.utils';

// ─── Library reference ────────────────────────────────────────────────────────
//
// ── Native balance ──────────────────────────────────────────
//
// ethers.js (this.evm):
//   const raw = await this.evm.provider.getBalance(address)     // BigInt in wei
//   formatBalance(raw, this.evm.config.decimals)
//
// web3.js (this.web3) — classic alternative:
//   const raw = await this.web3.instance.eth.getBalance(address) // BigInt in wei
//   formatBalance(raw, 18)
//
// Solana (this.sol):
//   const pk  = new PublicKey(address)
//   const raw = await this.sol.connection.getBalance(pk)         // number in lamports
//   formatBalance(raw, this.sol.decimals)
//
// TON (this.ton):
//   const addr    = this.ton.parseAddress(address)
//   const raw     = await this.ton.client.getBalance(addr)       // BigInt in nanoTON
//   formatBalance(raw, this.ton.decimals)
//
// ── Transactions ─────────────────────────────────────────────
//
// EVM Explorer API (Etherscan / BscScan / Polygonscan):
//   GET <this.evm.config.explorerApiUrl>
//     ?module=account&action=txlist
//     &address=<address>&sort=desc&page=1&offset=<limit>
//     &apikey=<this.evm.explorerApiKey>
//
// Solana:
//   const pk = new PublicKey(address)
//   await this.sol.connection.getSignaturesForAddress(pk, { limit })
//   → array of ConfirmedSignatureInfo
//
// ── Tokens & NFTs (Moralis — works for EVM and Solana) ───────
//
// EVM tokens:
//   const res = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
//     address, chain: this.moralis.evmChainId,
//   })
//   res.result → array with .token.name, .token.symbol, .value, .token.decimals
//
// Solana tokens:
//   const res = await this.moralis.sdk.SolApi.account.getSPLs({ address, network: 'mainnet' })
//
// EVM NFTs:
//   const res = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
//     address, chain: this.moralis.evmChainId,
//   })
//   res.result → array with .nft.contractAddress, .nft.name, .tokenId
//
// Solana NFTs via Metaplex (this.metaplex):
//   const owner = new PublicKey(address)
//   const nfts  = await this.metaplex.sdk.nfts().findAllByOwner({ owner })
//   nfts → array of Metadata: .name, .symbol, .mintAddress
//
// ── Utilities ────────────────────────────────────────────────
//
// Decimal.js (decimal.utils.ts):
//   formatBalance(raw, decimals, dp?)       — wei/lamports → human-readable string
//   hasBalanceChanged(prev, curr, threshold?) — detect meaningful balance change
//
// EventEmitter2 (this.events):
//   this.events.emit(WALLET_BALANCE_CHANGED, payload: WalletBalanceChangedEvent)
//
// Redis:
//   this.redis.get / set / hset / hgetall / lrange / lpush / ltrim
//
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_KEYS = {
  balance: (address: string) => `balance:${address}`,
  transactions: (address: string, limit: number) => `txs:${address}:${limit}`,
  tokens: (address: string) => `tokens:${address}`,
  nfts: (address: string) => `nfts:${address}`,
  lastBalance: (address: string) => `last_balance:${address}`,
  watchlist: 'watchlist',
  alerts: 'wallet:alerts',
};

const CACHE_TTL = {
  balance: 30,      // seconds
  transactions: 60, // seconds
  tokens: 120,      // seconds
  nfts: 300,        // seconds
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly network: string;

  constructor(
    private readonly redis: RedisService,
    private readonly evm: EvmProvider,
    private readonly sol: SolanaProvider,
    private readonly web3: Web3Provider,
    private readonly ton: TonProvider,
    private readonly moralis: MoralisProvider,
    private readonly metaplex: MetaplexProvider,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2,
  ) {
    this.network = this.configService.get<string>('NETWORK', 'ethereum');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Implement balance fetching
  //
  // Steps:
  //   1. Build cache key via CACHE_KEYS.balance(address)
  //   2. Check cache: const cached = await this.redis.get(key)
  //   3. If cache hit → parse JSON and return with cached: true
  //   4. Fetch raw balance from blockchain (pick any provider — see reference above)
  //      EVM:    this.evm  | this.web3
  //      Solana: this.sol
  //      TON:    this.ton
  //   5. Convert with formatBalance(raw, decimals)
  //   6. Build WalletBalance and cache for CACHE_TTL.balance seconds
  //   7. Return with cached: false
  // ─────────────────────────────────────────────────────────────────────────
  async getBalance(address: string): Promise<WalletBalance> {
    const key = CACHE_KEYS.balance(address);
    const cached = await this.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as WalletBalance;
      return { ...parsed, cached: true };
    }

    let rawBalance: bigint | number | string;
    let decimals: number;
    let symbol: string;

    if (this.isEvmNetwork()) {
      this.ensureEvmAddress(address);
      if (!this.evm.provider || !this.evm.config) {
        throw new ServiceUnavailableException('EVM provider is not initialized');
      }
      rawBalance = await this.evm.provider.getBalance(address);
      decimals = this.evm.config.decimals;
      symbol = this.evm.config.symbol;
    } else if (this.network === 'solana') {
      this.ensureSolanaAddress(address);
      if (!this.sol.connection) {
        throw new ServiceUnavailableException('Solana provider is not initialized');
      }
      rawBalance = await this.sol.connection.getBalance(new PublicKey(address));
      decimals = this.sol.decimals;
      symbol = this.sol.symbol;
    } else if (this.network === 'ton') {
      if (!this.ton.client) {
        throw new ServiceUnavailableException('TON provider is not initialized');
      }
      let tonAddress;
      try {
        tonAddress = this.ton.parseAddress(address);
      } catch {
        throw new BadRequestException('Invalid TON address');
      }
      rawBalance = await this.ton.client.getBalance(tonAddress);
      decimals = this.ton.decimals;
      symbol = this.ton.symbol;
    } else {
      throw new BadRequestException(`Unsupported network "${this.network}"`);
    }

    const result: WalletBalance = {
      address,
      balance: this.safeFormatBalance(rawBalance, decimals),
      symbol,
      network: this.network,
      cached: false,
    };

    await this.redis.set(key, JSON.stringify(result), CACHE_TTL.balance);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Implement transaction history fetching
  //
  // Steps:
  //   1. Build cache key via CACHE_KEYS.transactions(address, limit)
  //   2. Check cache (same pattern as getBalance)
  //   3. Fetch from blockchain (see library reference)
  //   4. Map to Transaction[] (hash, from, to, value, timestamp, status)
  //   5. Use formatBalance() for EVM tx value fields if needed
  //   6. Cache for CACHE_TTL.transactions seconds
  //   7. Return TransactionList with cached: false
  // ─────────────────────────────────────────────────────────────────────────
  async getTransactions(address: string, limit = 10): Promise<TransactionList> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const key = CACHE_KEYS.transactions(address, safeLimit);
    const cached = await this.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as TransactionList;
      return { ...parsed, cached: true };
    }

    let transactions: TransactionList['transactions'] = [];

    if (this.isEvmNetwork()) {
      this.ensureEvmAddress(address);
      if (!this.evm.config?.explorerApiUrl) {
        throw new ServiceUnavailableException('EVM explorer API is not configured');
      }

      let response;
      try {
        response = await axios.get(this.evm.config.explorerApiUrl, {
          params: {
            module: 'account',
            action: 'txlist',
            address,
            sort: 'desc',
            page: 1,
            offset: safeLimit,
            apikey: this.evm.explorerApiKey || '',
          },
          timeout: 15000,
        });
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const isTimeout =
            error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout');
          if (isTimeout) {
            this.logger.warn(
              `Explorer timeout for ${this.network} address=${address} limit=${safeLimit}`,
            );
            throw new GatewayTimeoutException(
              `Explorer API timeout on ${this.network}. Try again shortly.`,
            );
          }

          this.logger.warn(
            `Explorer request failed for ${this.network}: ${error.message}`,
          );
          throw new BadGatewayException(
            `Explorer API request failed on ${this.network}.`,
          );
        }

        throw error;
      }

      const explorerResult = Array.isArray(response.data?.result)
        ? response.data.result
        : [];

      transactions = explorerResult.map((tx: any) => {
        const isPending = !tx.blockNumber || Number(tx.blockNumber) === 0;
        const isFailed =
          tx.txreceipt_status === '0' ||
          tx.isError === '1' ||
          tx.status === '0';

        return {
          hash: tx.hash || '',
          from: tx.from || '',
          to: tx.to || '',
          value: this.safeFormatBalance(tx.value ?? '0', this.evm.config.decimals),
          timestamp: Number(tx.timeStamp || 0),
          status: isPending ? 'pending' : isFailed ? 'failed' : 'success',
        };
      });
    } else if (this.network === 'solana') {
      this.ensureSolanaAddress(address);
      if (!this.sol.connection) {
        throw new ServiceUnavailableException('Solana provider is not initialized');
      }

      const signatures = await this.sol.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit: safeLimit },
      );

      transactions = signatures.map((tx) => ({
        hash: tx.signature,
        from: '',
        to: '',
        value: '0.000000',
        timestamp: tx.blockTime ?? 0,
        status: tx.err ? 'failed' : 'success',
      }));
    } else if (this.network === 'ton') {
      // Public TON tx APIs are less standardized in this starter;
      // keep endpoint functional with an empty list.
      transactions = [];
    } else {
      throw new BadRequestException(`Unsupported network "${this.network}"`);
    }

    const result: TransactionList = {
      address,
      transactions: transactions.slice(0, safeLimit),
      network: this.network,
      cached: false,
    };

    await this.redis.set(key, JSON.stringify(result), CACHE_TTL.transactions);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Add a wallet to the watchlist
  //
  // Redis Hash storage:
  //   await this.redis.hset(CACHE_KEYS.watchlist, dto.address,
  //     JSON.stringify({ address: dto.address, label: dto.label, addedAt: Date.now() }))
  //
  // Return: { success: true, address: dto.address }
  // ─────────────────────────────────────────────────────────────────────────
  async watchWallet(dto: WatchWalletDto): Promise<{ success: boolean; address: string }> {
    await this.redis.hset(
      CACHE_KEYS.watchlist,
      dto.address,
      JSON.stringify({
        address: dto.address,
        label: dto.label,
        addedAt: Date.now(),
      }),
    );

    return { success: true, address: dto.address };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return all watched wallets with balances + emit events on changes
  //
  // Steps:
  //   1. const all = await this.redis.hgetall(CACHE_KEYS.watchlist)
  //   2. Parse each value with JSON.parse
  //   3. For each wallet: fetch balance via this.getBalance(address)
  //   4. Load previous: await this.redis.get(CACHE_KEYS.lastBalance(address))
  //   5. If changed (hasBalanceChanged(prev, current)):
  //        this.events.emit(WALLET_BALANCE_CHANGED, {
  //          address, network: this.network, symbol,
  //          previousBalance: prev ?? '0', currentBalance: current,
  //          detectedAt: Date.now(),
  //        } as WalletBalanceChangedEvent)
  //   6. Persist: await this.redis.set(CACHE_KEYS.lastBalance(address), current)
  //   7. Return WatchedWalletWithBalance[]
  // ─────────────────────────────────────────────────────────────────────────
  async getWatchedWallets(): Promise<WatchedWalletWithBalance[]> {
    const all = await this.redis.hgetall(CACHE_KEYS.watchlist);
    const entries = Object.values(all)
      .map((raw) => {
        try {
          return JSON.parse(raw) as {
            address: string;
            label?: string;
            addedAt?: number;
          };
        } catch {
          this.logger.warn(`Skipping invalid watchlist item: ${raw}`);
          return null;
        }
      })
      .filter((item): item is { address: string; label?: string; addedAt?: number } => !!item);

    return Promise.all(
      entries.map(async (wallet) => {
        const current = await this.getBalance(wallet.address);
        const previous = await this.redis.get(CACHE_KEYS.lastBalance(wallet.address));
        const previousBalance = previous ?? '0';

        if (hasBalanceChanged(previousBalance, current.balance)) {
          this.events.emit(WALLET_BALANCE_CHANGED, {
            address: wallet.address,
            network: this.network,
            symbol: current.symbol,
            previousBalance,
            currentBalance: current.balance,
            detectedAt: Date.now(),
          } as WalletBalanceChangedEvent);
        }

        await this.redis.set(CACHE_KEYS.lastBalance(wallet.address), current.balance);

        return {
          address: wallet.address,
          label: wallet.label,
          addedAt: wallet.addedAt ?? Date.now(),
          balance: current.balance,
          symbol: current.symbol,
        };
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return stored balance change alerts
  //
  //   1. const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1)
  //   2. return raw.map(item => JSON.parse(item) as BalanceAlert)
  // ─────────────────────────────────────────────────────────────────────────
  async getAlerts(): Promise<BalanceAlert[]> {
    const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1);
    return raw
      .map((item) => {
        try {
          return JSON.parse(item) as BalanceAlert;
        } catch {
          this.logger.warn(`Skipping invalid alert payload: ${item}`);
          return null;
        }
      })
      .filter((item): item is BalanceAlert => !!item);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return ERC-20 / SPL token balances for a wallet
  //
  // Use Moralis (works for both EVM and Solana):
  //
  //   EVM:
  //     const res = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
  //       address, chain: this.moralis.evmChainId,
  //     })
  //     Map res.result to TokenBalance[]
  //       contractAddress: item.token?.contractAddress?.lowercase
  //       name:            item.token?.name
  //       symbol:          item.token?.symbol
  //       decimals:        item.token?.decimals
  //       balance:         formatBalance(item.value, item.token?.decimals ?? 18)
  //
  //   Solana:
  //     const res = await this.moralis.sdk.SolApi.account.getSPLs({
  //       address, network: 'mainnet',
  //     })
  //     Map res.result to TokenBalance[]
  //
  // Cache result for CACHE_TTL.tokens seconds
  // ─────────────────────────────────────────────────────────────────────────
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    const key = CACHE_KEYS.tokens(address);
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as TokenBalance[];
    }

    if (!this.moralis.isAvailable()) {
      throw new ServiceUnavailableException(
        'Moralis is not initialized. Set MORALIS_API_KEY to use token endpoints',
      );
    }

    let tokens: TokenBalance[] = [];

    if (this.isEvmNetwork()) {
      this.ensureEvmAddress(address);
      const res = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
        address,
        chain: this.moralis.evmChainId,
      });

      tokens = (res.result ?? []).map((item: any) => {
        const decimals = Number(item?.token?.decimals ?? 18);
        return {
          contractAddress:
            item?.token?.contractAddress?.lowercase ||
            item?.token?.contractAddress?.checksum ||
            '',
          name: item?.token?.name ?? '',
          symbol: item?.token?.symbol ?? '',
          decimals,
          balance: this.safeFormatBalance(item?.value ?? '0', decimals),
          network: this.network,
        };
      });
    } else if (this.network === 'solana') {
      this.ensureSolanaAddress(address);
      const res = await this.moralis.sdk.SolApi.account.getSPL({
        address,
        network: 'mainnet',
      });

      const splJson = res.toJSON() as any[];
      tokens = (splJson ?? []).map((item: any) => ({
        contractAddress: item?.mint ?? '',
        name: item?.name ?? '',
        symbol: item?.symbol ?? '',
        decimals: Number(item?.decimals ?? 0),
        balance:
          typeof item?.amount === 'string' && item.amount.includes('.')
            ? item.amount
            : this.safeFormatBalance(item?.amountRaw ?? '0', Number(item?.decimals ?? 0)),
        network: this.network,
      }));
    } else {
      throw new BadRequestException(
        `Token balances are not supported for network "${this.network}"`,
      );
    }

    await this.redis.set(key, JSON.stringify(tokens), CACHE_TTL.tokens);
    return tokens;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return NFTs owned by a wallet
  //
  // EVM — use Moralis:
  //   const res = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
  //     address, chain: this.moralis.evmChainId,
  //   })
  //   Map res.result to NftItem[]
  //     contractAddress: item.nft?.contractAddress?.lowercase
  //     tokenId:         item.tokenId
  //     name:            item.nft?.name
  //     symbol:          item.nft?.symbol
  //
  // Solana — use Metaplex:
  //   const owner = new PublicKey(address)
  //   const nfts  = await this.metaplex.sdk.nfts().findAllByOwner({ owner })
  //   Map to NftItem[]
  //     mint:   nft.mintAddress.toBase58()
  //     name:   nft.name
  //     symbol: nft.symbol
  //
  // Cache result for CACHE_TTL.nfts seconds
  // ─────────────────────────────────────────────────────────────────────────
  async getNfts(address: string): Promise<NftItem[]> {
    const key = CACHE_KEYS.nfts(address);
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as NftItem[];
    }

    let nfts: NftItem[] = [];

    if (this.isEvmNetwork()) {
      this.ensureEvmAddress(address);
      if (!this.moralis.isAvailable()) {
        throw new ServiceUnavailableException(
          'Moralis is not initialized. Set MORALIS_API_KEY to use NFT endpoints',
        );
      }

      const res = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
        address,
        chain: this.moralis.evmChainId,
      });

      nfts = (res.result ?? []).map((item: any) => ({
        contractAddress:
          item?.nft?.contractAddress?.lowercase ||
          item?.nft?.contractAddress?.checksum ||
          '',
        tokenId: String(item?.tokenId ?? ''),
        name: item?.nft?.name ?? 'Unknown NFT',
        symbol: item?.nft?.symbol ?? '',
        network: this.network,
      }));
    } else if (this.network === 'solana') {
      this.ensureSolanaAddress(address);
      if (!this.metaplex.isAvailable()) {
        throw new ServiceUnavailableException('Metaplex is not initialized');
      }

      const owner = new PublicKey(address);
      const metadata = await this.metaplex.sdk.nfts().findAllByOwner({ owner });

      nfts = metadata.map((nft: any) => ({
        mint: nft?.mintAddress?.toBase58?.() ?? '',
        name: nft?.name ?? 'Unknown NFT',
        symbol: nft?.symbol ?? '',
        network: this.network,
      }));
    } else {
      throw new BadRequestException(`NFTs are not supported for network "${this.network}"`);
    }

    await this.redis.set(key, JSON.stringify(nfts), CACHE_TTL.nfts);
    return nfts;
  }

  private isEvmNetwork(): boolean {
    return ['ethereum', 'bnb', 'polygon'].includes(this.network);
  }

  private ensureEvmAddress(address: string): void {
    if (!isValidEvmAddress(address)) {
      throw new BadRequestException('Invalid EVM address');
    }
  }

  private ensureSolanaAddress(address: string): void {
    if (!isValidSolanaAddress(address)) {
      throw new BadRequestException('Invalid Solana address');
    }
  }

  private safeFormatBalance(raw: bigint | number | string, decimals: number): string {
    try {
      return formatBalance(raw, decimals);
    } catch {
      this.logger.warn(`Failed to format balance value "${String(raw)}"`);
      return '0.000000';
    }
  }
}
