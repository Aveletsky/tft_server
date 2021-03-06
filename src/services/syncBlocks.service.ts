import { CurrencyService } from './currency.service';
import { TftApiService } from './tftAPI.service';
import { CacheService } from './cache.service';

import * as Block from '../models/block';
import * as Transaction from '../models/transaction';
import * as Wallet from '../models/wallet';

import * as logStdout from 'single-line-log';

export class SyncBlockService {
    private tftService;
    private currencyService;
    private cache;
    private log;

    private currentSyncedBlock;
    private isSynced;

    constructor() {
        this.isSynced = false;
        this.currentSyncedBlock = -1;
        this.log = logStdout.stdout;

        this.tftService = new TftApiService();
        this.currencyService = new CurrencyService();
        this.cache = new CacheService();
        this.runSync();
    }

    private addBalance = async (address: string, value: number) => {
        return await Wallet.update({
            _id: address
        }, {
            $inc: {
                balance: value,
                totalReceived: value
            },
            updatedAt: new Date()
        })
    }

    private removeBalance = async (address: string, value: number) => {
        return await Wallet.update({
            _id: address
        }, {
            $inc: {
                balance: value * -1,
            },
            updatedAt: new Date()
        });
    }

    private runSync = async () => {
        const maxBlockHeight = (await this.tftService.getCurrentInfo()).height;
        const lastSyncedBlock = await Block.findOne({}).sort('-height').select('height').lean();

        let startIndex = 0;

        if (lastSyncedBlock) {
            startIndex = lastSyncedBlock.height + 1;
        }

        let currentIndex = startIndex;

        while (currentIndex <= maxBlockHeight) {
            const currentBlock = await this.tftService.getBlockById(currentIndex);
            const { coinPrice, currencyRate, tftPrice } = await this.currencyService.getLastInfo('BTC', 'USD', ['TFT_BTC', 'TFT_USD']);
            const minerPayouts = [];


            let minerReward = 0;

            if (currentBlock.block.minerpayoutids) {
                for (let i = 0; i < currentBlock.block.minerpayoutids.length; i++) {
                    const value = Number.parseInt(currentBlock.block.rawblock.minerpayouts[i].value);
                    const address = currentBlock.block.rawblock.minerpayouts[i].unlockhash;
                    minerPayouts.push({
                        minerPayoutId: currentBlock.block.minerpayoutids[i],
                        unlockHash: address,
                        value,
                    });

                    minerReward += value;
    
                    await this.checkNewWallet(address);
                    await this.addBalance(address, value);
                }
            }

            const block = new Block({
                _id: currentBlock.block.blockid,
                height: currentBlock.block.height,
                parentId: currentBlock.block.rawblock.parentid,
                timeStamp: currentBlock.block.rawblock.timestamp,
                difficulty: Number.parseInt(currentBlock.block.difficulty),
                activeBlockStake: Number.parseInt(currentBlock.block.estimatedactivebs),
                transactionsCount: currentBlock.block.transactions.length,
                minerReward,
                minerPayouts,
                rates: {
                    btcUsd: coinPrice,
                    usdEur: currencyRate,
                    tftPrice
                },
            });

            for (const item of currentBlock.block.transactions) {
                const existTx = await Transaction.findById(item.id);
                if (existTx) {
                    continue;
                }

                const t = (await this.tftService.findByHash(item.id)).transaction;

                const blockStakeInputs = [];

                if (t.rawtransaction.data.blockstakeinputs) {
                    for (let i = 0; i < t.rawtransaction.data.blockstakeinputs.length; i++) {
                        const current = t.rawtransaction.data.blockstakeinputs[i];
    
                        const blockStake = {
                            parentId: current.parentid,
                            address: t.blockstakeinputoutputs[i].condition.data.unlockhash,
                            value: Number.parseInt(t.blockstakeinputoutputs[i].value),
                            unlockType: t.blockstakeinputoutputs[i].condition.type,
                            publicKey: '',
                            signature: ''
                        };
    
                        if (current.fulfillment) {
                            blockStake.publicKey = current.fulfillment.data.publickey;
                            blockStake.signature = current.fulfillment.data.signature;
                        } else if (current.unlocker && current.unlocker.fulfillment) {
                            blockStake.publicKey = current.unlocker.condition.publickey;
                            blockStake.signature = current.unlocker.fulfillment.signature;
                        }
    
                        blockStakeInputs.push(blockStake);

                        await this.checkNewWallet(blockStake.address);
                    }
                }
                
                const coinInputs = [];

                if (t.rawtransaction.data.coininputs) {
                    for (let i = 0; i < t.rawtransaction.data.coininputs.length; i++) {
                        const current = t.rawtransaction.data.coininputs[i];
                        const value = Number.parseInt(t.coininputoutputs[i].value);
                        const inputs = {
                            parentId: current.parentid,
                            address: t.coininputoutputs[i].condition.data.unlockhash,
                            value,
                            unlockType: t.coininputoutputs[i].condition.type,
                            publicKey: '',
                            signature: ''
                        };
    
                        if (current.fulfillment) {
                            inputs.publicKey = current.fulfillment.data.publickey;
                            inputs.signature = current.fulfillment.data.signature;
                        } else if (current.unlocker && current.unlocker.fulfillment) {
                            inputs.publicKey = current.unlocker.condition.publickey;
                            inputs.signature = current.unlocker.fulfillment.signature;
                        }
    
                        coinInputs.push(inputs);

                        await this.checkNewWallet(inputs.address);
                        await this.removeBalance(inputs.address, value);
                    }
                }
                

                const blockStakeOutputs = [];

                if (t.rawtransaction.data.blockstakeoutputs) {
                    for (let i = 0; i < t.rawtransaction.data.blockstakeoutputs.length; i++) {
                        const current = t.rawtransaction.data.blockstakeoutputs[i];
                        blockStakeOutputs.push({
                            id: t.blockstakeoutputids[i],
                            address: current.unlockhash || current.condition.data.unlockhash,
                            value: Number.parseInt(current.value),
                        });

                        await this.checkNewWallet(current.unlockhash || current.condition.data.unlockhash);
                    }
                }
                
                const coinOutputs = [];

                if (t.rawtransaction.data.coinoutputs) {
                    for (let i = 0; i < t.rawtransaction.data.coinoutputs.length; i++) {
                        const current = t.rawtransaction.data.coinoutputs[i];
                        const address = current.unlockhash || current.condition.data.unlockhash || current.condition.data.condition.data.unlockhash;
                        const value = Number.parseInt(current.value);
                        let lockTime = null;
                        
                        if (current.condition && current.condition.data && current.condition.data.locktime) {
                            lockTime = current.condition.data.locktime;
                        }

                        coinOutputs.push({
                            id: t.coinoutputids[i],
                            address,
                            value,
                            lockTime,
                        });

                        await this.checkNewWallet(address);
                        await this.addBalance(address, value);
                    }
                }

                const tx = new Transaction({
                    _id: t.id,
                    parentId: t.parent,
                    blockInfo: {
                        height: t.height,
                        id: block._id,
                        timeStamp: block.timeStamp,
                    },
                    blockStakeInputCount: blockStakeInputs.length,
                    blockStakeOutputCount: blockStakeOutputs.length,
                    blockStakeInputs,
                    blockStakeOutputs,
                    coinInputs,
                    coinOutputs,
                    coinInputCount: coinInputs.length,
                    coinOutputCount: coinOutputs.length,
                    minerFees: t.rawtransaction.data.minerfees,
                    rates: {
                        btcUsd: coinPrice,
                        usdEur: currencyRate,
                        tftPrice
                    },
                });

                await tx.save();
            }

            await block.save();

            this.cache.setField(`block_${block.height}`, block, 30);

            currentIndex ++;

            this.log.clear();
            this.log(`Current synced block ${block.height} / ${maxBlockHeight}`);
        }

        const newMaxBlockHeight = (await this.tftService.getCurrentInfo()).height;
        if (newMaxBlockHeight > maxBlockHeight) {
            return this.runSync();
        }

        this.isSynced = true;
        this.currentSyncedBlock = maxBlockHeight;

        return;
    }

    private checkNewWallet = async (address: string) => {
        if (!address) {
            return;
        }

        const exist = await Wallet.findById(address);
        if (!exist) {
            await new Wallet({
                _id: address
            }).save()
        }

        return;
    }

    public syncBlockByHeight = async (height: number) => {
        if (!this.isSynced) {
            return null;
        }

        if (this.currentSyncedBlock === height) {
            return null;
        }

        await this.runSync();

        const lastBlocks = await Block.find({}).sort('-height').limit(10).lean();

        const mаxSuply = await this.cache.getField(`mаxSuply`);
        if (mаxSuply) {
            this.cache.setField(`stats`, mаxSuply + lastBlocks[0].minerReward, 300);
        }
        
        return this.cache.setField(`lastBlocks`, lastBlocks, 300);
    }
}
