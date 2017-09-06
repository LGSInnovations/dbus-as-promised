'use strict';

const DBus = require('dbus');
const EventEmitter = require('events');

// take the common callback pattern used in DBus and convert it to a promise interface
function toAsync(fn) {
  return function (...args) {
    // make sure the returned function works as a method as well:
    // bind the function before using it in the promise
    const bound_fn = fn.bind(this);
    return new Promise((resolve, reject) =>
      bound_fn(...args, (err, ok) => err ? reject (err) : resolve(ok)));
  };
}

// TODO: promisify registerService
DBus.registerService = undefined

const cb_getBus = DBus.getBus;
DBus.getBus = function (name) {
  let bus = cb_getBus.bind(this)(name);
  
  const cb_getInterface = bus.getInterface;
  bus.getInterface = async function (...args) {
    let iface = await toAsync(cb_getInterface.bind(this))(...args);

    iface.getProperties = toAsync(iface.getProperties);
    iface.getProperty   = toAsync(iface.getProperty);
    iface.setProperty   = toAsync(iface.setProperty);

    // iterate over RPC methods and convert them to async
    for (let name in iface.object.method)
    {
      iface[name] = toAsync(iface[name]);
    }

    return iface;
  }
  return bus;
}

function unwrapInterface(thing) {
  return (thing && thing._iface) ? thing.objectPath : thing;
}

// wrapper that takes a DBus interface and exposes its
// methods, properties and signals with hooks allowing
// them to be extended using 'class' style code.
class InterfaceWrapper extends EventEmitter {
  constructor(iface) {
    super();
    
    this.objectPath = iface.objectPath;
    this._iface = iface;
    this._boundSignalHandlers = [];

    // export all DBus methods that aren't overridden, and auto-unwrap
    // all InterfaceWrapper arguments passed to their corresponding object paths
    // TODO: translate args and returns based on declared signature
    for (let name in iface.object.method)
    {
      // TODO: check this, working from memory of structures here
      // TODO: similar autotranslation of properties?
      let methodInfo = iface.object.method[name];
      let transformArgs = this._transformMethodArgs.bind(this, name, methodInfo.in);
      let transformRet = this._transformMethodReturn.bind(this, name, methodInfo.out);
      
      if (!this[name]) this[name] = async function (...args) {
        return transformRet(await iface[name](...(await transformArgs(args))));
      };
    }

    // expose the properties interface
    this.getProperties  = iface.getProperties.bind(iface);
    this.getProperty  = iface.getProperty.bind(iface);
    this.setProperty  = iface.setProperty.bind(iface);

    // expose the signals interface in a way that allows subclasses
    // to alter the signal contents (for example, to convert object
    // paths to higher level wrappers for the objects they represent)
    this.on('newListener', function (e) {
      if (!this.listenerCount(e) && e in iface.object.signal) {
        this._iface.addListener(e, this._boundSignalHandler(e));
      }
    });

    this.on('removeListener', function (e) {
      if (!this.listenerCount(e) && e in iface.object.signal) {
        this._iface.removeListener(e, this._boundSignalHandler(e));
      }
    });
  }
  
  get methods() {
    return Object.keys(this._iface.object.method).sort();
  }

  get properties() {
    return Object.keys(this._iface.object.property).sort();
  }
  
  get signals() {
    return Object.keys(this._iface.object.signal).sort();
  }
  
  _transformMethodArgs(method, sig, args) {
    return args.map(unwrapInterface);
  }
  
  _transformMethodReturn(method, sig, ret) {
    // TODO: auto-wrap returned object paths?
    return ret;
  }
  
  async _interpretSignal(signal, args) {
    return args;
  }

  async _onSignal(signal, ...args) {
    this.emit(signal, ...(await this._interpretSignal(signal, args)))
  }

  _boundSignalHandler(e) {
    if (!this._boundSignalHandlers[e])
    {
      this._boundSignalHandlers[e] = this._onSignal.bind(this, e);
    }

    return this._boundSignalHandlers[e];
  }
}

DBus.InterfaceWrapper = InterfaceWrapper;
DBus.unwrapInterface = unwrapInterface;
module.exports = DBus;
