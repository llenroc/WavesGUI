(function () {
    'use strict';

    /**
     * @param {app.utils.apiWorker} apiWorker
     * @param {app.utils.decorators} decorators
     * @param {User} user
     * @param {app.utils} utils
     * @param {EventManager} eventManager
     * @return {AssetsService}
     */
    const factory = function (apiWorker, decorators, user, utils, eventManager) {

        const ASSET_NAME_MAP = {
            [WavesApp.defaultAssets.ETH]: 'Ethereum',
            [WavesApp.defaultAssets.EUR]: 'Euro',
            [WavesApp.defaultAssets.USD]: 'Usd',
            [WavesApp.defaultAssets.BTC]: 'Bitcoin'
        };

        class AssetsService {

            /**
             * @param {string} assetId
             * @return {Promise<IAssetInfo>}
             */
            @decorators.cachable()
            getAssetInfo(assetId) {
                if (assetId === WavesApp.defaultAssets.WAVES) {
                    return user.onLogin()
                        .then(() => ({
                            id: WavesApp.defaultAssets.WAVES,
                            name: 'Waves',
                            precision: 8,
                            reissuable: false,
                            quantity: 100000000,
                            timestamp: 1460408400000,
                            sender: WavesApp.defaultAssets.WAVES
                        }));
                }
                return user.onLogin()
                    .then(() => {
                        return apiWorker.process((Waves, { assetId }) => {
                            return Waves.API.Node.v1.transactions.get(assetId);
                        }, { assetId })
                            .then((asset) => ({
                                id: asset.id,
                                name: ASSET_NAME_MAP[asset.id] || asset.name,
                                description: asset.description,
                                precision: asset.decimals,
                                reissuable: asset.reissuable,
                                quantity: asset.quantity,
                                timestamp: asset.timestamp,
                                sender: asset.sender
                            }));
                    });
            }

            /**
             * @param {string} assetId
             * @return {Promise<IAssetWithBalance>}
             */
            getBalance(assetId) {
                return Promise.all([this._getBalance(assetId), eventManager.getBalanceEvents()])
                    .then((data) => {
                        const [asset, events] = data;
                        const clone = tsUtils.cloneDeep(asset);

                        clone.balance = this._getAssetBalance(clone.id, clone.balance, events);
                        return clone;
                    });
            }

            /**
             * @param {string[]} [assetIds]
             * @param {Object} [options]
             * @param {Object} [options.limit]
             * @param {Object} [options.offset]
             * @return {Promise}
             */
            getBalanceList(assetIds, options) {
                return user.onLogin()
                    .then(() => {
                        if (assetIds) {
                            return utils.whenAll([
                                Promise.all(assetIds.map(this.getAssetInfo)),
                                eventManager.getBalanceEvents(),
                                this._getBalanceList(assetIds, options)
                            ])
                                .then(([assets, events, balances]) => {
                                    return assets.map((asset) => {
                                        const balanceData = tsUtils.find(balances, { assetId: asset.id });
                                        const balance = balanceData && parseFloat(balanceData.tokens) || 0;
                                        return { ...asset, balance: this._getAssetBalance(asset.id, balance, events) };
                                    });
                                });
                        } else {
                            return utils.whenAll([
                                this._getBalanceList(null, options),
                                eventManager.getBalanceEvents()
                            ])
                                .then(([list, events]) => {
                                    return utils.whenAll(list.map((item) => this.getAssetInfo(item.assetId)))
                                        .then((infoList) => {
                                            return infoList.map((asset, i) => {
                                                const balance = parseFloat(list[i].tokens) || 0;
                                                return {
                                                    ...asset,
                                                    balance: this._getAssetBalance(asset.id, balance, events)
                                                };
                                            })
                                                .filter((asset) => { // TODO Fix API error with empty balance
                                                    return asset.id === WavesApp.defaultAssets.WAVES || asset.balance !== 0;
                                                });
                                        });
                                });
                        }
                    });
            }

            @decorators.cachable(2)
            getBidAsk(assetId1, assetId2) {
                return apiWorker.process((Waves, { assetId1, assetId2 }) => {
                    return Waves.API.Matcher.v1.getOrderbook(assetId1, assetId2)
                        .then((orderbook) => {
                            const bid = String(orderbook.bids.length && orderbook.bids[0].price || 0);
                            const ask = String(orderbook.asks.length && orderbook.asks[0].price || 0);

                            return Promise.all([
                                Waves.OrderPrice.fromTokens(bid, assetId1, assetId2)
                                    .then((item) => item.getTokens()),
                                Waves.OrderPrice.fromTokens(ask, assetId1, assetId2)
                                    .then((item) => item.getTokens())
                            ])
                                .then((list) => ({ bid: list[0], ask: list[1] }));
                        });
                }, { assetId1, assetId2 });
            }

            @decorators.cachable(60)
            getChange(idFrom, idTo) {
                const marketUrl = 'https://marketdata.wavesplatform.com/api/candles';

                const params = {
                    onFetch: utils.onFetch,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    idFrom,
                    idTo,
                    marketUrl
                };

                return apiWorker.process((Waves, { onFetch, wavesId, idFrom, idTo, marketUrl }) => {

                    if (idFrom === idTo) {
                        return 1;
                    }

                    const getRate = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/1440/1`)
                                    .then(onFetch)
                                    .then((data) => {
                                        if (!data || !data.length) {
                                            return 0;
                                        }
                                        const open = Number(data[0].open);
                                        const close = Number(data[0].close);
                                        if (open > close) {
                                            return close === 0 ? 0 : -open / close;
                                        } else {
                                            return open === 0 ? 0 : close / open;
                                        }
                                    });
                            });
                    };

                    if (idFrom !== wavesId && idTo !== wavesId) {
                        return Promise.all([
                            getRate(idFrom, wavesId),
                            getRate(idTo, wavesId)
                        ])
                            .then((rateList) => {
                                return rateList[1] === 0 ? 0 : rateList[0] / rateList[1];
                            });
                    } else {
                        return getRate(idFrom, idTo);
                    }

                }, params);
            }

            /**
             * @param {string} idFrom
             * @param {string} idTo
             * @return {Promise<AssetsService.rateApi>}
             */
            @decorators.cachable(60)
            getRate(idFrom, idTo) {
                const marketUrl = 'https://marketdata.wavesplatform.com/api/trades';

                const params = {
                    onFetch: utils.onFetch,
                    currentRate: AssetsService._currentRate,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    idFrom,
                    idTo,
                    marketUrl
                };

                return apiWorker.process((Waves, { onFetch, currentRate, wavesId, idFrom, idTo, marketUrl }) => {

                    if (idFrom === idTo) {
                        return 1;
                    }

                    const getRate = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/5`)
                                    .then(onFetch)
                                    .then(currentRate)
                                    .then((rate) => {
                                        if (from !== pair.priceAsset.id) {
                                            return rate;
                                        } else {
                                            return rate === 0 ? 0 : 1 / rate;
                                        }
                                    });
                            });
                    };

                    if (idFrom !== wavesId && idTo !== wavesId) {
                        return Promise.all([
                            getRate(idFrom, wavesId),
                            getRate(idTo, wavesId)
                        ])
                            .then((rateList) => {
                                return rateList[1] === 0 ? 0 : rateList[0] / rateList[1];
                            });
                    } else {
                        return getRate(idFrom, idTo);
                    }

                }, params)
                    .then((rate) => {
                        return this._generateRateApi(rate);
                    });
            }

            @decorators.cachable(20)
            getRateHistory(fromId, toId, time, count) {
                const params = {
                    onFetch: utils.onFetch,
                    time, count,
                    fromId, toId,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    marketUrl: 'https://marketdata.wavesplatform.com/api/candles'
                };

                return apiWorker.process((Waves, { onFetch, time, count, fromId, toId, marketUrl, wavesId }) => {

                    const getRateHistory = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/${time}/${count}`)
                                    .then(onFetch)
                                    .then((list) => {
                                        if (!list || !list.length) {
                                            return Promise.reject(list);
                                        }

                                        return list.reduce((result, item) => {
                                            const close = Number(item.close);
                                            let rate = from !== pair.priceAsset.id ? close : 1 / close;

                                            if (close !== 0) {
                                                result.push({
                                                    timestamp: new Date(item.timestamp),
                                                    rate: rate
                                                });
                                            }

                                            return result;
                                        }, []);
                                    });
                            });
                    };

                    if (fromId !== wavesId && toId !== wavesId) {
                        return Promise.all([
                            getRateHistory(fromId, wavesId),
                            getRateHistory(toId, wavesId)
                        ])
                            .then((rateList) => {
                                const from = rateList[0];
                                const to = rateList[1];

                                const toHash = function (list) {
                                    return list.reduce((result, item) => {
                                        result[item.timestamp.valueOf()] = item;
                                        return result;
                                    }, Object.create(null));
                                };

                                const hash = toHash(to);

                                return from.reduce((result, item) => {
                                    if (hash[item.timestamp.valueOf()]) {
                                        item.rate = item.rate / hash[item.timestamp.valueOf()].rate;
                                        result.push(item);
                                    }
                                    return result;
                                }, []);
                            });
                    } else {
                        return getRateHistory(fromId, toId);
                    }

                }, params);
            }

            /**
             * @return {Promise<IFeeData>}
             */
            getFeeSend() {
                return utils.when({
                    id: WavesApp.defaultAssets.WAVES,
                    fee: 0.001
                });
            }

            /**
             * @param {string} assetId
             * @param {number} balance
             * @param {Array<ChangeBalanceEvent>} events
             * @return {*}
             * @private
             */
            _getAssetBalance(assetId, balance, events) {
                return events.reduce((balance, balanceEvent) => {
                    return balance - balanceEvent.getBalanceDifference(assetId);
                }, balance);
            }

            /**
             * @param {Array<string>} [assets]
             * @param {Object} [options]
             * @param {Object} [options.limit]
             * @param {Object} [options.offset]
             * @private
             */
            @decorators.cachable(2)
            _getBalanceList(assets, { limit = null, offset = null } = Object.create(null)) {
                return apiWorker.process((WavesAPI, { assets, address, limit, offset }) => {
                    return WavesAPI.API.Node.v2.addresses.balances(address, { assets, limit, offset })
                        .then((assets) => assets.map(item => item.amount.toJSON()));
                }, { assets, address: user.address, limit, offset });
            }

            /**
             * @param {string} assetId
             * @return {Promise<IAssetWithBalance>}
             * @private
             */
            @decorators.cachable(2)
            _getBalance(assetId) {
                return this.getAssetInfo(assetId)
                    .then((info) => {
                        const handler = (Waves, { address, assetId }) => {
                            return Waves.API.Node.v1.assets.balance(address, assetId);
                        };
                        const data = { address: user.address, assetId: info.id };

                        return apiWorker.process(handler, data)
                            .then((data) => {
                                // TODO remove " / Math.pow(10, info.precision)" when Phill fix api.
                                return { ...info, balance: data.balance / Math.pow(10, info.precision) };
                            });
                    });
            }

            /**
             * @param {number} rate
             * @return {AssetsService.rateApi}
             * @private
             */
            _generateRateApi(rate) {
                return {
                    /**
                     * @name AssetsService.rateApi#exchange
                     * @param {BigNumber} balance
                     * @return {BigNumber}
                     */
                    exchange(balance) {
                        return balance.mul(rate.toFixed(8));
                    },

                    /**
                     * @name AssetsService.rateApi#exchangeReverse
                     * @param {BigNumber} balance
                     * @return {BigNumber}
                     */
                    exchangeReverse(balance) {
                        return rate ? balance.div(rate) : 0;
                    },

                    /**
                     * @name AssetsService.rateApi#rate
                     */
                    rate
                };
            }

            static _currentRate(trades) {
                return trades && trades.length ? trades.reduce((result, item) => {
                    return result + Number(item.price);
                }, 0) / trades.length : 0;
            }

        }

        return utils.bind(new AssetsService());
    };

    factory.$inject = ['apiWorker', 'decorators', 'user', 'utils', 'eventManager'];

    angular.module('app')
        .factory('assetsService', factory);
})();

/**
 * @name AssetsService.rateApi
 */

/**
 * @typedef {Object} IFeeData
 * @property {string} id
 * @property {number} fee
 */

/**
 * @typedef {Object} IBalance
 * @property {string} id
 * @property {number} precision
 * @property {number} balance
 */

/**
 * @typedef {Object} IAssetInfo
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */

/**
 * @typedef {Object} IAssetWithBalance
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {number} balance
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */