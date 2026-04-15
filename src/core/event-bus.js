// 全局事件总线单例，用于模块间解耦通信
const { EventEmitter } = require('events')
const bus = new EventEmitter()
bus.setMaxListeners(50)
module.exports = bus
