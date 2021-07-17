import { createDevnetConnection } from '../test/utils';
import { Account, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const FIXED_IDS = [
  {
    symbol: 'USDC',
    mint: '8FRFC6MoGGkMFQwngccyu69VnYbzykGeez7ignHVAFSN',
    dexPk: null,
  },
  {
    symbol: 'MNGO',
    mint: 'Bb9bsTQa1bGEtQ5KagGkvSHyuLqDWumFUcRqFusFNJWC',
    dexPk: 'Aph31hoXRjhk1QgCmRvs7WAWGdpRoaESMoqzjoFkL5mE',
  },
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    dexPk: 'uaajXobeb1hmTB6StRoa8Yqn6czjtWtFeVfZeJY6YFC',
  },
  {
    symbol: 'SRM',
    mint: 'AvtB6w9xboLwA145E221vhof5TddhqsChYcx7Fy3xVMH',
    dexPk: '23tRuJ3zUvXYQEnTDAcWHPDfmYvrWanpM2sJnmhL53X5',
  },
  {
    symbol: 'BTC',
    mint: '9EkC2nQZ4UTwUCP4dzAi3VxfeMYD87ZpqfZfhygGeR1P',
    dexPk: '6TwwNrueBAHe6VHwDYMhfTtkb7oP2vUnkun5yK8VzBbE',
  },
  {
    symbol: 'ETH',
    mint: 'Cu84KB3tDL6SbFgToHMLYVDJJXdJjenNzSKikeAvzmkA',
    dexPk: '2n81EqJgsTE5PoPX5H8adQ4EaVe5kXnFuxwdCAYfaExH',
  },
  {
    symbol: 'RAY',
    mint: '3YFQ7UYJ7sNGpXTKBxM3bYLVxKpzVudXAe4gLExh5b3n',
    dexPk: '3e7V65UdApsyCMLuALCoQwD9pKDCkozSUrsJx4XMJAnD',
  },
  {
    symbol: 'UNI',
    mint: '7vd84gXdjxRWjtwwkcxpzv1R8W9oCsADemNvRj3Cv5u2',
    dexPk: '4e9bt9ySh9i6Fks2R3KsWTBgJcEDNX6zM4RXHCcWDF3N',
  },
  {
    symbol: 'AAVE',
    mint: '3h7gNYC8aDJ5tGgDt6YKmvLJYT5LNcFb9yiVU1qirDWg',
    dexPk: 'BMigUjf6kDNtNDMCsBvPCwegbL45oLT7rtu1y36vAD1L',
  },
  {
    symbol: 'SUSHI',
    mint: 'Edi5KNs2LnonULNmoTQqSymJ7VuMC9amTjLN5RJ1YMcq',
    dexPk: 'J9aow2hcq6YMJGw7fAprGitP68crYa36r7yJYe5huFv4',
  },
  {
    symbol: 'STEP',
    mint: '62haNTBB4C3gESJyzAvQVAadNxN9zzVt39x5ep5wmaak',
    dexPk: '8P4kZg2c8pAUC6yLv289fR83LJ2wze1ZT247Fw6MhEiC',
  },
  {
    symbol: 'COPE',
    mint: 'BxZBNjYtMgzSF57aiCwrBdLuEL5tSNcGrxQXj7Z7mZQW',
    dexPk: 'Dzc5eZEGHoYEmrYDGWspWcHQw6FG67N6t8NiLhgsLRbi',
  },
  {
    symbol: 'DOGE',
    mint: '6yr1xJP6Nfu8Bxp4L8WJQrtLqBGZrQm5n41PFm4ZmEyk',
    dexPk: 'CrMr521AhZE1FQ9dtBQZczd6SKMpthJMTeQ8WGGRooQ3',
  },
  {
    symbol: 'FIDA',
    mint: 'DRuM89e9xndaRJvjc41zcVWzEAjaytDWUHASydfEEHic',
    dexPk: 'D3P93bKtRzzrJXtBwLcNrswJ3cei1qcrXM9jK6emWZJx',
  },
  {
    symbol: 'FTT',
    mint: 'Fxh4bpZnRCnpg2vcH11ttmSTDSEeC5qWbPRZNZWnRnqY',
    dexPk: 'CiN2BzCaThxLRDALeMq3GJGR24MQhdBWmHHjitW74oST',
  },
  {
    symbol: 'MEDIA',
    mint: 'CU4LrEQChVcis3fsMRciKTgNZSV5A3bh3ftF3Gqnbe78',
    dexPk: 't6Q9ADDNsaQspD4u111fkq8qBzgy1MWoyzX8mDKVbws',
  },
  {
    symbol: 'MER',
    mint: '3QAVaXixBUtHwjponbZZgNVSRqB8YiTqY59pGSWDVS7X',
    dexPk: 'D9Rc98dPsmkfi9wv9yQLKXXu86MZut5jWZSYVCRu51ay',
  },
];

const connection = createDevnetConnection();

let authority;
if (process.env.AUTHORITY) {
  authority = new Account(
    JSON.parse(fs.readFileSync(process.env.AUTHORITY, 'utf-8')),
  );
} else {
  authority = new Account(
    JSON.parse(
      fs.readFileSync(os.homedir() + '/.config/solana/devnet.json', 'utf-8'),
    ),
  );
}

let wallet;
if (process.env.WALLET) {
  wallet = new PublicKey(process.env.WALLET);
} else {
  wallet = authority.publicKey;
}

// TODO - move this into CLI and make it proper
async function mintDevnetTokens() {
  console.log(
    'minting for wallet:',
    wallet.toBase58(),
    'mint authority:',
    authority.publicKey.toBase58(),
  );

  for (let i = 0; i < FIXED_IDS.length; i++) {
    const token = new Token(
      connection,
      new PublicKey(FIXED_IDS[i].mint),
      TOKEN_PROGRAM_ID,
      authority,
    );

    if (FIXED_IDS[i].symbol === 'SOL') {
      console.log('not minting tokens for SOL');
      continue;
    } else if (FIXED_IDS[i].symbol === 'BTC') {
      console.log(
        'not minting tokens for BTC because we messed up. use faucet',
      );
      continue;
    }

    const tokenAccount = await token.getOrCreateAssociatedAccountInfo(wallet);
    await token.mintTo(tokenAccount.address, authority, [], 1000000000000);
    console.log('minted', FIXED_IDS[i].symbol);
  }
}

mintDevnetTokens();