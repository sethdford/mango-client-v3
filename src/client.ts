import {
  Account,
  Connection,
  // Keypair,
  PublicKey,
  SimulatedTransactionResponse,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
  // AccountInfo,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  awaitTransactionSignatureConfirmation,
  simulateTransaction,
  sleep,
  createAccountInstruction,
  createSignerKeyAndNonce,
  createTokenAccountInstructions,
  nativeToUi,
  uiToNative,
  zeroKey,
  getFilteredProgramAccounts,
} from './utils';
import {
  MerpsGroupLayout,
  NodeBankLayout,
  RootBankLayout,
  MerpsCacheLayout,
  MerpsAccountLayout,
  PerpMarket,
  StubOracleLayout,
  PerpMarketLayout,
  BookSideLayout,
  PerpEventQueueLayout,
  PerpEventLayout,
  EventQueue,
  EventQueueLayout,
} from './layout';
import MerpsGroup, { QUOTE_INDEX } from './MerpsGroup';
import MerpsAccount from './MerpsAccount';
import {
  makeAddOracleInstruction,
  makeAddPerpMarketInstruction,
  makeAddSpotMarketInstruction,
  makeAddToBasketInstruction,
  makeCachePerpMarketsInstruction,
  makeCachePricesInstruction,
  makeCacheRootBankInstruction,
  makeConsumeEventsInstruction,
  makeCancelSpotOrderInstruction,
  makeDepositInstruction,
  makeInitMerpsAccountInstruction,
  makeInitMerpsGroupInstruction,
  makePlacePerpOrderInstruction,
  makePlaceSpotOrderInstruction,
  makeSetOracleInstruction,
  makeSettleFundsInstruction,
  makeSettlePnlInstruction,
  makeUpdateFundingInstruction,
  makeUpdateRootBankInstruction,
  makeWithdrawInstruction,
  makeCancelPerpOrderInstruction,
} from './instruction';
import {
  Market,
  getFeeRates,
  getFeeTier,
  OpenOrders,
} from '@project-serum/serum';
import { I80F48, ZERO_I80F48 } from './fixednum';
import { Order } from '@project-serum/serum/lib/market';
import { RootBank } from './RootBank';
import { WalletAdapter } from './types';
import { PerpOrder } from '.';

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export class MerpsClient {
  connection: Connection;
  programId: PublicKey;

  constructor(connection: Connection, programId: PublicKey) {
    this.connection = connection;
    this.programId = programId;
  }

  async sendTransactions(
    transactions: Transaction[],
    payer: Account | WalletAdapter,
    additionalSigners: Account[],
    timeout = 30000,
    confirmLevel: TransactionConfirmationStatus = 'confirmed',
  ): Promise<TransactionSignature[]> {
    return await Promise.all(
      transactions.map((tx) =>
        this.sendTransaction(
          tx,
          payer,
          additionalSigners,
          timeout,
          confirmLevel,
        ),
      ),
    );
  }

  async signTransaction({ transaction, payer, signers }) {
    transaction.recentBlockhash = (
      await this.connection.getRecentBlockhash()
    ).blockhash;
    transaction.setSigners(payer.publicKey, ...signers.map((s) => s.publicKey));
    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }

    if (payer?.connected) {
      console.log('signing as wallet', payer.publicKey);
      return await payer.signTransaction(transaction);
    } else {
      transaction.sign(...[payer].concat(signers));
    }
  }

  // TODO - switch Account to Keypair and switch off setSigners due to deprecated
  async sendTransaction(
    transaction: Transaction,
    payer: Account | WalletAdapter,
    additionalSigners: Account[],
    timeout = 30000,
    confirmLevel: TransactionConfirmationStatus = 'processed',
  ): Promise<TransactionSignature> {
    await this.signTransaction({
      transaction,
      payer,
      signers: additionalSigners,
    });

    const rawTransaction = transaction.serialize();
    const startTime = getUnixTs();
    const txid: TransactionSignature = await this.connection.sendRawTransaction(
      rawTransaction,
      { skipPreflight: true },
    );
    console.log('Started awaiting confirmation for', txid);

    let done = false;
    (async () => {
      // TODO - make sure this works well on mainnet
      await sleep(2000);
      while (!done && getUnixTs() - startTime < timeout / 1000) {
        console.log(new Date().toUTCString(), ' sending tx ', txid);
        this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
        await sleep(2000);
      }
    })();

    try {
      await awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        this.connection,
        confirmLevel,
      );
    } catch (err) {
      if (err.timeout) {
        throw new Error('Timed out awaiting confirmation on transaction');
      }
      let simulateResult: SimulatedTransactionResponse | null = null;
      try {
        simulateResult = (
          await simulateTransaction(
            this.connection,
            transaction,
            'singleGossip',
          )
        ).value;
      } catch (e) {
        console.warn('Simulate transaction failed');
      }

      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
            const line = simulateResult.logs[i];
            if (line.startsWith('Program log: ')) {
              throw new Error(
                'Transaction failed: ' + line.slice('Program log: '.length),
              );
            }
          }
        }
        throw new Error(JSON.stringify(simulateResult.err));
      }
      throw new Error('Transaction failed');
    } finally {
      done = true;
    }

    console.log('Latency', txid, getUnixTs() - startTime);
    return txid;
  }

  async initMerpsGroup(
    quoteMint: PublicKey,
    dexProgram: PublicKey,
    validInterval: number,
    payer: Account | WalletAdapter,
  ): Promise<PublicKey> {
    const accountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      MerpsGroupLayout.span,
      this.programId,
    );
    const { signerKey, signerNonce } = await createSignerKeyAndNonce(
      this.programId,
      accountInstruction.account.publicKey,
    );
    const quoteVaultAccount = new Account();

    const quoteVaultAccountInstructions = await createTokenAccountInstructions(
      this.connection,
      payer.publicKey,
      quoteVaultAccount.publicKey,
      quoteMint,
      signerKey,
    );

    const quoteNodeBankAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      NodeBankLayout.span,
      this.programId,
    );
    const quoteRootBankAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      RootBankLayout.span,
      this.programId,
    );
    const cacheAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      MerpsCacheLayout.span,
      this.programId,
    );

    const initMerpsGroupInstruction = makeInitMerpsGroupInstruction(
      this.programId,
      accountInstruction.account.publicKey,
      signerKey,
      payer.publicKey,
      quoteMint,
      quoteVaultAccount.publicKey,
      quoteNodeBankAccountInstruction.account.publicKey,
      quoteRootBankAccountInstruction.account.publicKey,
      cacheAccountInstruction.account.publicKey,
      dexProgram,
      new BN(signerNonce),
      new BN(validInterval),
    );

    const transaction = new Transaction();
    transaction.add(accountInstruction.instruction);
    transaction.add(...quoteVaultAccountInstructions);
    transaction.add(quoteNodeBankAccountInstruction.instruction);
    transaction.add(quoteRootBankAccountInstruction.instruction);
    transaction.add(cacheAccountInstruction.instruction);
    transaction.add(initMerpsGroupInstruction);

    await this.sendTransaction(transaction, payer, [
      accountInstruction.account,
      quoteVaultAccount,
      quoteNodeBankAccountInstruction.account,
      quoteRootBankAccountInstruction.account,
      cacheAccountInstruction.account,
    ]);

    return accountInstruction.account.publicKey;
  }

  async getMerpsGroup(merpsGroup: PublicKey): Promise<MerpsGroup> {
    const accountInfo = await this.connection.getAccountInfo(merpsGroup);
    const decoded = MerpsGroupLayout.decode(
      accountInfo == null ? undefined : accountInfo.data,
    );

    return new MerpsGroup(merpsGroup, decoded);
  }

  async initMerpsAccount(
    merpsGroup: MerpsGroup,
    owner: Account | WalletAdapter,
  ): Promise<PublicKey> {
    const accountInstruction = await createAccountInstruction(
      this.connection,
      owner.publicKey,
      MerpsAccountLayout.span,
      this.programId,
    );

    const initMerpsAccountInstruction = makeInitMerpsAccountInstruction(
      this.programId,
      merpsGroup.publicKey,
      accountInstruction.account.publicKey,
      owner.publicKey,
    );

    // Add all instructions to one atomic transaction
    const transaction = new Transaction();
    transaction.add(accountInstruction.instruction);
    transaction.add(initMerpsAccountInstruction);

    const additionalSigners = [accountInstruction.account];
    await this.sendTransaction(transaction, owner, additionalSigners);

    return accountInstruction.account.publicKey;
  }

  async getMerpsAccount(
    merpsAccountPk: PublicKey,
    dexProgramId: PublicKey,
  ): Promise<MerpsAccount> {
    const acc = await this.connection.getAccountInfo(
      merpsAccountPk,
      'singleGossip',
    );
    const merpsAccount = new MerpsAccount(
      merpsAccountPk,
      MerpsAccountLayout.decode(acc == null ? undefined : acc.data),
    );
    await merpsAccount.loadOpenOrders(this.connection, dexProgramId);
    return merpsAccount;
  }

  async deposit(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,
    rootBank: PublicKey,
    nodeBank: PublicKey,
    vault: PublicKey,
    tokenAcc: PublicKey,

    quantity: number,
  ): Promise<TransactionSignature> {
    const tokenIndex = merpsGroup.getRootBankIndex(rootBank);
    const nativeQuantity = uiToNative(
      quantity,
      merpsGroup.tokens[tokenIndex].decimals,
    );

    const transaction = new Transaction();

    if (!merpsAccount.inBasket[tokenIndex]) {
      // TODO: find out why this does not work
      transaction.add(
        makeAddToBasketInstruction(
          this.programId,
          merpsGroup.publicKey,
          merpsAccount.publicKey,
          owner.publicKey,
          new BN(tokenIndex),
        ),
      );
    }

    const instruction = makeDepositInstruction(
      this.programId,
      merpsGroup.publicKey,
      owner.publicKey,
      merpsAccount.publicKey,
      rootBank,
      nodeBank,
      vault,
      tokenAcc,
      nativeQuantity,
    );

    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async withdraw(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,
    rootBank: PublicKey,
    nodeBank: PublicKey,
    vault: PublicKey,
    tokenAcc: PublicKey,

    quantity: number,
    allowBorrow: boolean,
  ): Promise<TransactionSignature> {
    const tokenIndex = merpsGroup.getRootBankIndex(rootBank);
    const nativeQuantity = uiToNative(
      quantity,
      merpsGroup.tokens[tokenIndex].decimals,
    );

    const instruction = makeWithdrawInstruction(
      this.programId,
      merpsGroup.publicKey,
      merpsAccount.publicKey,
      owner.publicKey,
      merpsGroup.merpsCache,
      rootBank,
      nodeBank,
      vault,
      tokenAcc,
      merpsGroup.signerKey,
      merpsAccount.spotOpenOrders,
      nativeQuantity,
      allowBorrow,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  // Keeper functions
  async cacheRootBanks(
    merpsGroup: PublicKey,
    merpsCache: PublicKey,
    rootBanks: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const cacheRootBanksInstruction = makeCacheRootBankInstruction(
      this.programId,
      merpsGroup,
      merpsCache,
      rootBanks,
    );

    const transaction = new Transaction();
    transaction.add(cacheRootBanksInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async cachePrices(
    merpsGroup: PublicKey,
    merpsCache: PublicKey,
    oracles: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const cachePricesInstruction = makeCachePricesInstruction(
      this.programId,
      merpsGroup,
      merpsCache,
      oracles,
    );

    const transaction = new Transaction();
    transaction.add(cachePricesInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async cachePerpMarkets(
    merpsGroup: PublicKey,
    merpsCache: PublicKey,
    perpMarkets: PublicKey[],
    payer: Account,
  ): Promise<TransactionSignature> {
    const cachePerpMarketsInstruction = makeCachePerpMarketsInstruction(
      this.programId,
      merpsGroup,
      merpsCache,
      perpMarkets,
    );

    const transaction = new Transaction();
    transaction.add(cachePerpMarketsInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async updateRootBank(
    merpsGroup: PublicKey,
    rootBank: PublicKey,
    nodeBanks: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const updateRootBanksInstruction = makeUpdateRootBankInstruction(
      this.programId,
      merpsGroup,
      rootBank,
      nodeBanks,
    );

    const transaction = new Transaction();
    transaction.add(updateRootBanksInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async consumeEvents(
    merpsGroup: PublicKey,
    perpMarket: PublicKey,
    eventQueue: PublicKey,
    merpsAccounts: PublicKey[],
    payer: Account,
    limit: BN,
  ): Promise<TransactionSignature> {
    const updateRootBanksInstruction = makeConsumeEventsInstruction(
      this.programId,
      merpsGroup,
      perpMarket,
      eventQueue,
      merpsAccounts,
      limit,
    );

    const transaction = new Transaction();
    transaction.add(updateRootBanksInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async updateFunding(
    merpsGroup: PublicKey,
    merpsCache: PublicKey,
    perpMarket: PublicKey,
    bids: PublicKey,
    asks: PublicKey,
    payer: Account,
  ): Promise<TransactionSignature> {
    const updateFundingInstruction = makeUpdateFundingInstruction(
      this.programId,
      merpsGroup,
      merpsCache,
      perpMarket,
      bids,
      asks,
    );

    const transaction = new Transaction();
    transaction.add(updateFundingInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async getPerpMarket(
    perpMarketPk: PublicKey,
    baseDecimal: number,
    quoteDecimal: number,
  ): Promise<PerpMarket> {
    const acc = await this.connection.getAccountInfo(perpMarketPk);
    const perpMarket = new PerpMarket(
      perpMarketPk,
      baseDecimal,
      quoteDecimal,
      PerpMarketLayout.decode(acc?.data),
    );
    return perpMarket;
  }

  async placePerpOrder(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    merpsCache: PublicKey,
    perpMarket: PerpMarket,
    owner: Account | WalletAdapter,

    side: 'buy' | 'sell',
    price: number,
    quantity: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
    clientOrderId = 0,
  ): Promise<TransactionSignature> {
    const marketIndex = merpsGroup.getPerpMarketIndex(perpMarket);

    // TODO: this will not work for perp markets without spot market
    const baseTokenInfo = merpsGroup.tokens[marketIndex];
    const quoteTokenInfo = merpsGroup.tokens[QUOTE_INDEX];
    const baseUnit = Math.pow(10, baseTokenInfo.decimals);
    const quoteUnit = Math.pow(10, quoteTokenInfo.decimals);

    const nativePrice = new BN(price * quoteUnit)
      .mul(perpMarket.contractSize)
      .div(perpMarket.quoteLotSize.mul(new BN(baseUnit)));
    const nativeQuantity = new BN(quantity * baseUnit).div(
      perpMarket.contractSize,
    );

    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    if (!merpsAccount.inBasket[marketIndex]) {
      transaction.add(
        makeAddToBasketInstruction(
          this.programId,
          merpsGroup.publicKey,
          merpsAccount.publicKey,
          owner.publicKey,
          new BN(marketIndex),
        ),
      );
    }

    const instruction = makePlacePerpOrderInstruction(
      this.programId,
      merpsGroup.publicKey,
      merpsAccount.publicKey,
      owner.publicKey,
      merpsCache,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      perpMarket.eventQueue,
      merpsAccount.spotOpenOrders,
      nativePrice,
      nativeQuantity,
      new BN(clientOrderId),
      side,
      orderType,
    );
    transaction.add(instruction);

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async cancelPerpOrder(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,
    perpMarket: PerpMarket,
    order: PerpOrder,
  ): Promise<TransactionSignature> {
    const instruction = makeCancelPerpOrderInstruction(
      this.programId,
      merpsGroup.publicKey,
      merpsAccount.publicKey,
      owner.publicKey,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      perpMarket.eventQueue,
      order,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async loadRootBanks(rootBanks: PublicKey[]): Promise<RootBank[]> {
    const accounts = await Promise.all(
      rootBanks.map((pk) => this.connection.getAccountInfo(pk)),
    );

    const parsedRootBanks: RootBank[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (acc) {
        const decoded = RootBankLayout.decode(acc.data);
        parsedRootBanks.push(new RootBank(rootBanks[i], decoded));
      }
    }

    return parsedRootBanks;
  }

  /*
  async loadPerpMarkets(perpMarkets: PublicKey[]): Promise<PerpMarket[]> {
    const accounts = await Promise.all(
      perpMarkets.map((pk) => this.connection.getAccountInfo(pk)),
    );

    const parsedPerpMarkets: PerpMarket[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (acc) {
        const decoded = PerpMarketLayout.decode(acc.data);
        parsedPerpMarkets.push(new PerpMarket(perpMarkets[i], decoded));
      }
    }

    return parsedPerpMarkets;
  }
  */

  async addOracle(
    merpsGroup: MerpsGroup,
    oracle: PublicKey,
    admin: Account,
  ): Promise<TransactionSignature> {
    const instruction = makeAddOracleInstruction(
      this.programId,
      merpsGroup.publicKey,
      oracle,
      admin.publicKey,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async setOracle(
    merpsGroup: MerpsGroup,
    oracle: PublicKey,
    admin: Account,
    price: I80F48,
  ): Promise<TransactionSignature> {
    const instruction = makeSetOracleInstruction(
      this.programId,
      merpsGroup.publicKey,
      oracle,
      admin.publicKey,
      price,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async addSpotMarket(
    merpsGroup: MerpsGroup,
    spotMarket: PublicKey,
    mint: PublicKey,
    admin: Account,

    marketIndex: number,
    maintLeverage: number,
    initLeverage: number,
  ): Promise<TransactionSignature> {
    const vaultAccount = new Account();

    const vaultAccountInstructions = await createTokenAccountInstructions(
      this.connection,
      admin.publicKey,
      vaultAccount.publicKey,
      mint,
      merpsGroup.signerKey,
    );

    const nodeBankAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      NodeBankLayout.span,
      this.programId,
    );
    const rootBankAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      RootBankLayout.span,
      this.programId,
    );

    const instruction = makeAddSpotMarketInstruction(
      this.programId,
      merpsGroup.publicKey,
      spotMarket,
      merpsGroup.dexProgramId,
      mint,
      nodeBankAccountInstruction.account.publicKey,
      vaultAccount.publicKey,
      rootBankAccountInstruction.account.publicKey,
      admin.publicKey,
      new BN(marketIndex),
      I80F48.fromNumber(maintLeverage),
      I80F48.fromNumber(initLeverage),
    );

    const transaction = new Transaction();
    transaction.add(...vaultAccountInstructions);
    transaction.add(nodeBankAccountInstruction.instruction);
    transaction.add(rootBankAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [
      vaultAccount,
      nodeBankAccountInstruction.account,
      rootBankAccountInstruction.account,
    ];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async addToBasket(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,

    marketIndex: number,
  ): Promise<TransactionSignature> {
    const instruction = makeAddToBasketInstruction(
      this.programId,
      merpsGroup.publicKey,
      merpsAccount.publicKey,
      owner.publicKey,
      new BN(marketIndex),
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async placeSpotOrder(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    merpsCache: PublicKey,
    spotMarket: Market,
    owner: Account | WalletAdapter,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
  ): Promise<TransactionSignature> {
    const limitPrice = spotMarket.priceNumberToLots(price);
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

    // TODO implement srm vault fee discount
    // const feeTier = getFeeTier(0, nativeToUi(merpsGroup.nativeSrm || 0, SRM_DECIMALS));
    const feeTier = getFeeTier(0, nativeToUi(0, 0));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(
      spotMarket
        .baseSizeNumberToLots(size)
        .mul(spotMarket.priceNumberToLots(price)),
    );

    if (maxBaseQuantity.lte(new BN(0))) {
      throw new Error('size too small');
    }
    if (limitPrice.lte(new BN(0))) {
      throw new Error('invalid price');
    }
    const selfTradeBehavior = 'decrementTake';

    const spotMarketIndex = merpsGroup.getSpotMarketIndex(spotMarket.publicKey);

    const { baseRootBank, baseNodeBank, quoteRootBank, quoteNodeBank } =
      await merpsGroup.loadBanksForSpotMarket(this.connection, spotMarketIndex);

    if (!baseRootBank || !baseNodeBank || !quoteRootBank || !quoteNodeBank)
      throw new Error('Empty banks');

    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    if (!merpsAccount.inBasket[spotMarketIndex]) {
      // TODO: find out why this does not work
      transaction.add(
        makeAddToBasketInstruction(
          this.programId,
          merpsGroup.publicKey,
          merpsAccount.publicKey,
          owner.publicKey,
          new BN(spotMarketIndex),
        ),
      );
    }

    const openOrdersKeys: PublicKey[] = [];
    for (let i = 0; i < merpsAccount.spotOpenOrders.length; i++) {
      if (
        i === spotMarketIndex &&
        merpsAccount.spotOpenOrders[spotMarketIndex].equals(zeroKey)
      ) {
        // open orders missing for this market; create a new one now
        const openOrdersSpace = OpenOrders.getLayout(
          merpsGroup.dexProgramId,
        ).span;
        const openOrdersLamports =
          await this.connection.getMinimumBalanceForRentExemption(
            openOrdersSpace,
            'singleGossip',
          );
        const accInstr = await createAccountInstruction(
          this.connection,
          owner.publicKey,
          openOrdersSpace,
          merpsGroup.dexProgramId,
          openOrdersLamports,
        );

        transaction.add(accInstr.instruction);
        additionalSigners.push(accInstr.account);
        openOrdersKeys.push(accInstr.account.publicKey);
      } else {
        openOrdersKeys.push(merpsAccount.spotOpenOrders[i]);
      }
    }

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const placeOrderInstruction = makePlaceSpotOrderInstruction(
      this.programId,
      merpsGroup.publicKey,
      merpsAccount.publicKey,
      owner.publicKey,
      merpsCache,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      spotMarket['_decoded'].requestQueue,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      baseRootBank.publicKey,
      baseNodeBank.publicKey,
      quoteRootBank.publicKey,
      quoteNodeBank.publicKey,
      quoteNodeBank.vault,
      baseNodeBank.vault,
      merpsGroup.signerKey,
      dexSigner,
      openOrdersKeys,

      side,
      limitPrice,
      maxBaseQuantity,
      maxQuoteQuantity,
      selfTradeBehavior,
      orderType,
    );
    transaction.add(placeOrderInstruction);

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async cancelSpotOrder(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,
    spotMarket: Market,
    order: Order,
  ): Promise<TransactionSignature> {
    const instruction = makeCancelSpotOrderInstruction(
      this.programId,
      merpsGroup.publicKey,
      owner.publicKey,
      merpsAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      order.openOrdersAddress,
      merpsGroup.signerKey,
      spotMarket['_decoded'].eventQueue,
      order,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async settleFunds(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    owner: Account | WalletAdapter,
    spotMarket: Market,
  ): Promise<TransactionSignature> {
    const marketIndex = merpsGroup.getSpotMarketIndex(spotMarket.publicKey);
    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const { baseNodeBank, quoteNodeBank } =
      await merpsGroup.loadBanksForSpotMarket(this.connection, marketIndex);

    if (!baseNodeBank || !quoteNodeBank) {
      throw new Error('Invalid or missing node banks');
    }

    const instruction = makeSettleFundsInstruction(
      this.programId,
      merpsGroup.publicKey,
      owner.publicKey,
      merpsAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      merpsAccount.spotOpenOrders[marketIndex],
      merpsGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      merpsGroup.tokens[marketIndex].rootBank,
      baseNodeBank.publicKey,
      merpsGroup.tokens[QUOTE_INDEX].rootBank,
      quoteNodeBank.publicKey,
      baseNodeBank.vault,
      quoteNodeBank.vault,
      dexSigner,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  /**
   * Automatically fetch MerpsAccounts for this PerpMarket
   * Pick enough MerpsAccounts that have opposite sign and send them in to get settled
   */
  async settlePnl(
    merpsGroup: MerpsGroup,
    merpsAccount: MerpsAccount,
    perpMarket: PerpMarket,
    quoteRootBank: RootBank,
    price: I80F48, // should be the MerpsCache price
    owner: Account | WalletAdapter,
  ): Promise<TransactionSignature | null> {
    // fetch all MerpsAccounts filtered for having this perp market in basket
    const marketIndex = merpsGroup.getPerpMarketIndex(perpMarket);
    const perpMarketInfo = merpsGroup.perpMarkets[marketIndex];
    const pnl = merpsAccount.perpAccounts[marketIndex].getPnl(
      perpMarketInfo,
      price,
    );

    // Can't settle pnl if there is no pnl
    if (pnl.eq(ZERO_I80F48)) {
      return null;
    }

    const filter = {
      memcmp: {
        offset: MerpsAccountLayout.offsetOf('inBasket') + marketIndex,
        bytes: '2', // TODO - check if this actually works; needs to be base58 encoding of true byte
      },
    };

    const merpsAccounts = await this.getAllMerpsAccounts(merpsGroup, [filter]);

    const sign = pnl.gt(ZERO_I80F48) ? 1 : -1;

    const accountsWithPnl = merpsAccounts
      .map((m) => ({
        account: m,
        pnl: m.perpAccounts[marketIndex].getPnl(perpMarketInfo, price),
      }))
      .sort((a, b) => sign * a.pnl.cmp(b.pnl));

    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    // TODO - make sure we limit number of instructions to not go over tx size limit
    for (const account of accountsWithPnl) {
      // if pnl has changed sign, then we're down
      const remSign = pnl.gt(ZERO_I80F48) ? 1 : -1;
      if (remSign !== sign) {
        break;
      }

      // Account pnl must have opposite signs
      if (pnl.mul(account.pnl).gte(ZERO_I80F48)) {
        break;
      }

      const instr = makeSettlePnlInstruction(
        this.programId,
        merpsGroup.publicKey,
        merpsAccount.publicKey,
        account.account.publicKey,
        merpsGroup.merpsCache,
        quoteRootBank.publicKey,
        quoteRootBank.nodeBanks[0],
        new BN(marketIndex),
      );

      transaction.add(instr);
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);

    // Calculate the profit or loss per market
  }

  getMarginAccountsForOwner(
    merpsGroup: MerpsGroup,
    owner: PublicKey,
    includeOpenOrders = false,
  ): Promise<MerpsAccount[]> {
    const filters = [
      {
        memcmp: {
          offset: MerpsAccountLayout.offsetOf('owner'),
          bytes: owner.toBase58(),
        },
      },
    ];

    return this.getAllMerpsAccounts(merpsGroup, filters, includeOpenOrders);
  }

  async getAllMerpsAccounts(
    merpsGroup: MerpsGroup,
    filters?: any[],
    includeOpenOrders = false,
  ): Promise<MerpsAccount[]> {
    const accountFilters = [
      {
        memcmp: {
          offset: MerpsAccountLayout.offsetOf('merpsGroup'),
          bytes: merpsGroup.publicKey.toBase58(),
        },
      },
      {
        dataSize: MerpsAccountLayout.span,
      },
    ];

    if (filters && filters.length) {
      accountFilters.push(...filters);
    }

    const merpsAccountProms = getFilteredProgramAccounts(
      this.connection,
      this.programId,
      accountFilters,
    ).then((accounts) =>
      accounts.map(({ publicKey, accountInfo }) => {
        return new MerpsAccount(
          publicKey,
          MerpsAccountLayout.decode(
            accountInfo == null ? undefined : accountInfo.data,
          ),
        );
      }),
    );

    if (!includeOpenOrders) {
      return await merpsAccountProms;
    }

    const ordersFilters = [
      {
        memcmp: {
          offset: OpenOrders.getLayout(merpsGroup.dexProgramId).offsetOf(
            'owner',
          ),
          bytes: merpsGroup.signerKey.toBase58(),
        },
      },
      {
        dataSize: OpenOrders.getLayout(merpsGroup.dexProgramId).span,
      },
    ];

    const openOrdersProms = getFilteredProgramAccounts(
      this.connection,
      merpsGroup.dexProgramId,
      ordersFilters,
    ).then((accounts) =>
      accounts.map(({ publicKey, accountInfo }) =>
        OpenOrders.fromAccountInfo(
          publicKey,
          accountInfo,
          merpsGroup.dexProgramId,
        ),
      ),
    );

    const merpsAccounts = await merpsAccountProms;
    const openOrders = await openOrdersProms;

    const pkToOpenOrdersAccount = {};
    openOrders.forEach(
      (openOrdersAccount) =>
        (pkToOpenOrdersAccount[openOrdersAccount.publicKey.toBase58()] =
          openOrdersAccount),
    );

    for (const ma of merpsAccounts) {
      for (let i = 0; i < ma.spotOpenOrders.length; i++) {
        if (ma.spotOpenOrders[i].toBase58() in pkToOpenOrdersAccount) {
          ma.spotOpenOrdersAccounts[i] =
            pkToOpenOrdersAccount[ma.spotOpenOrders[i].toBase58()];
        }
      }
    }

    return merpsAccounts;
  }

  async addStubOracle(merpsGroupPk: PublicKey, admin: Account) {
    const createOracleAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      StubOracleLayout.span,
      this.programId,
    );

    const instruction = makeAddOracleInstruction(
      this.programId,
      merpsGroupPk,
      createOracleAccountInstruction.account.publicKey,
      admin.publicKey,
    );

    const transaction = new Transaction();
    transaction.add(createOracleAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [createOracleAccountInstruction.account];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async setStubOracle(
    merpsGroupPk: PublicKey,
    oraclePk: PublicKey,
    admin: Account,
    price: number,
  ) {
    const instruction = makeSetOracleInstruction(
      this.programId,
      merpsGroupPk,
      oraclePk,
      admin.publicKey,
      I80F48.fromNumber(price),
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async addPerpMarket(
    merpsGroupPk: PublicKey,
    admin: Account,
    marketIndex: number,
    maintLeverage: number,
    initLeverage: number,
    baseLotSize: number,
    quoteLotSize: number,
    maxNumEvents: number,
  ) {
    const makePerpMarketAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      PerpMarketLayout.span,
      this.programId,
    );

    const makeEventQueueAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      PerpEventQueueLayout.span + maxNumEvents * PerpEventLayout.span,
      this.programId,
    );

    const makeBidAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const makeAskAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const instruction = await makeAddPerpMarketInstruction(
      this.programId,
      merpsGroupPk,
      makePerpMarketAccountInstruction.account.publicKey,
      makeEventQueueAccountInstruction.account.publicKey,
      makeBidAccountInstruction.account.publicKey,
      makeAskAccountInstruction.account.publicKey,
      admin.publicKey,
      new BN(marketIndex),
      I80F48.fromNumber(maintLeverage),
      I80F48.fromNumber(initLeverage),
      new BN(baseLotSize),
      new BN(quoteLotSize),
    );

    const transaction = new Transaction();
    transaction.add(makePerpMarketAccountInstruction.instruction);
    transaction.add(makeEventQueueAccountInstruction.instruction);
    transaction.add(makeBidAccountInstruction.instruction);
    transaction.add(makeAskAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [
      makePerpMarketAccountInstruction.account,
      makeEventQueueAccountInstruction.account,
      makeBidAccountInstruction.account,
      makeAskAccountInstruction.account,
    ];

    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async getOrderBook() {}

  async getEventQueue(eventQueue: PublicKey): Promise<EventQueue> {
    const accountInfo = await this.connection.getAccountInfo(eventQueue);
    EventQueueLayout;
    const decoded = PerpEventQueueLayout.decode(
      accountInfo == null ? undefined : accountInfo.data,
      0,
    );

    return new EventQueue(decoded);
  }
}
