import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
    Liquidity,
    LiquidityPoolKeys,
    jsonInfo2PoolKeys,
    LiquidityPoolJsonInfo,
    TokenAccount,
    Token,
    TokenAmount,
    TOKEN_PROGRAM_ID,
    Percent,
} from "@raydium-io/raydium-sdk";
import { Wallet } from "@project-serum/anchor";
import base58 from "bs58";

class RaydiumSwap {
    allPoolKeysJson: LiquidityPoolJsonInfo[]
    connection: Connection;
    wallet: Wallet;

    constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
        this.connection = new Connection(RPC_URL, { commitment: 'confirmed' });
        this.wallet = new Wallet(Keypair.fromSecretKey(base58.decode(WALLET_PRIVATE_KEY)));
    }

    async loadPoolKeys() {
        const liquidityJsonResp = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
        if (!(liquidityJsonResp).ok) return []
        const liquidityJson = await liquidityJsonResp.json() as { official: any, unOfficial: any };
        const allPoolKeysJson = [...((liquidityJson)?.official ?? []), ...(liquidityJson?.unOfficial ?? [])]

        this.allPoolKeysJson = allPoolKeysJson;
    }

    findPoolInfoForTokens(mintA: string, mintB: string) {
        const poolData = this.allPoolKeysJson.find(i => i.baseMint === mintA && i.quoteMint === mintB || i.baseMint === mintB && i.quoteMint === mintA);

        if (!poolData) return null;

        return jsonInfo2PoolKeys(poolData) as LiquidityPoolKeys;
    }


    async getSwapTransaction(fromToken: string, toToken: string, amount: number, poolKeys: LiquidityPoolKeys, maxLamports: number = 100000) {
        const { minAmountOut, amountIn } = await this.calcAmountOut(poolKeys, amount, false);

        const fromAccount = this.getTokenAccountByOwnerAndMint(new PublicKey(fromToken));
        const toAccount = this.getTokenAccountByOwnerAndMint(new PublicKey(toToken));

        const swapTransaction = await Liquidity.makeSwapInstructionSimple({
            connection: this.connection,
            makeTxVersion: 1,
            poolKeys: {
                ...poolKeys,
            },
            userKeys: {
                tokenAccounts: [fromAccount, toAccount],
                owner: this.wallet.publicKey
            },
            amountIn: amountIn,
            amountOut: minAmountOut,
            fixedSide: "in",
            config: {
                bypassAssociatedCheck: false,
            },
            computeBudgetConfig: {
                microLamports: maxLamports
            }
        });

        const recentBlockhashForSwap = await this.connection.getLatestBlockhash();

        const allocateTransaction = new Transaction({
            blockhash: recentBlockhashForSwap.blockhash,
            lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
            feePayer: this.wallet.publicKey,
        });

        allocateTransaction.add(...swapTransaction.innerTransactions[0].instructions.filter(Boolean))

        return allocateTransaction;
    }

    async sendTransaction(tx: Transaction) {
        const txid = await this.connection.sendTransaction(tx, [
            this.wallet.payer,
        ], {
            skipPreflight: true,
            maxRetries: 2
        });

        return txid
    }

    async simulateTransaction(tx: Transaction) {
        const txid = await this.connection.simulateTransaction(tx, [
            this.wallet.payer,
        ]);

        return txid
    }

    getTokenAccountByOwnerAndMint(mint: PublicKey) {
        return {
            programId: TOKEN_PROGRAM_ID,
            pubkey: PublicKey.default,
            accountInfo: {
                mint: mint,
                amount: 0
            }
        } as unknown as TokenAccount
    }

    async calcAmountOut(poolKeys: LiquidityPoolKeys, rawAmountIn: number, swapInDirection: boolean) {
        const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys });

        let currencyInMint = poolKeys.baseMint;
        let currencyInDecimals = poolInfo.baseDecimals;
        let currencyOutMint = poolKeys.quoteMint;
        let currencyOutDecimals = poolInfo.quoteDecimals;

        if (!swapInDirection) {
            currencyInMint = poolKeys.quoteMint;
            currencyInDecimals = poolInfo.quoteDecimals;
            currencyOutMint = poolKeys.baseMint;
            currencyOutDecimals = poolInfo.baseDecimals;
        }

        const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals);
        const amountIn = new TokenAmount(currencyIn, rawAmountIn, false);
        const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals);
        const slippage = new Percent(5, 100); // 5% slippage

        const {
            amountOut,
            minAmountOut,
            currentPrice,
            executionPrice,
            priceImpact,
            fee,
        } = Liquidity.computeAmountOut({ poolKeys, poolInfo, amountIn, currencyOut, slippage, });

        return {
            amountIn,
            amountOut,
            minAmountOut,
            currentPrice,
            executionPrice,
            priceImpact,
            fee,
        };
    }
}


export default RaydiumSwap