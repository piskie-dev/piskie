/*
 * DevTools frontend observation subset, commit 61277feec01840bfa7cffb21d90bed500f973c70.
 * Copyright The Chromium Authors and original third-party authors.
 * Local bootstrap adapted from chrome-devtools-mcp 1.10.1; Copyright 2025-2026 Google LLC.
 * Modified by Piskie Team, 2026. See LICENSE, LICENSE-APACHE, NOTICE, licenses/,
 * and the accompanying .LEGAL.txt file for preserved notices.
 */
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/node/HostRuntime.ts
var HostRuntime_exports = {};
__export(HostRuntime_exports, {
  HOST_RUNTIME: () => HOST_RUNTIME
});
import * as Fs from "node:fs";
import * as Url from "node:url";
import * as WorkerThreads from "node:worker_threads";
var NodeWorkerScope, NodeWorker, NodeCacheEntry, NodeCacheStorage, nodeCacheStorage, HOST_RUNTIME;
var init_HostRuntime = __esm({
  "devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/node/HostRuntime.ts"() {
    "use strict";
    NodeWorkerScope = class {
      postMessage(message, transfer) {
        WorkerThreads.parentPort?.postMessage(message, transfer);
      }
      set onmessage(listener) {
        WorkerThreads.parentPort?.addEventListener("message", (msg) => {
          listener(msg);
        });
      }
    };
    NodeWorker = class {
      #worker;
      #workerPromise;
      #disposed = false;
      #rejectWorkerPromise;
      constructor(url) {
        const worker = new WorkerThreads.Worker(new URL(url));
        this.#worker = worker;
        this.#workerPromise = new Promise((resolve, reject) => {
          this.#rejectWorkerPromise = reject;
          worker.once("message", (message) => {
            if (message === "workerReady") {
              resolve(worker);
            }
          });
          worker.on("error", reject);
        });
        this.#workerPromise.catch(() => {
        });
      }
      postMessage(message, transfer) {
        void this.#workerPromise.then((worker) => {
          if (!this.#disposed) {
            worker.postMessage(message, transfer);
          }
        });
      }
      dispose() {
        this.#disposed = true;
        void this.#worker.terminate();
      }
      terminate(immediately) {
        if (immediately) {
          this.#rejectWorkerPromise?.(new Error("Worker terminated"));
        }
        this.dispose();
      }
      set onmessage(listener) {
        void this.#workerPromise.then((worker) => {
          worker.on("message", (data) => {
            if (!this.#disposed) {
              listener({ data, ports: [] });
            }
          });
        });
      }
      set onerror(listener) {
        void this.#workerPromise.then((worker) => {
          worker.on("error", (error) => {
            if (!this.#disposed) {
              listener({ type: "error", ...error });
            }
          });
        });
      }
    };
    NodeCacheEntry = class {
      #entries = /* @__PURE__ */ new Map();
      async put(url, response) {
        this.#entries.set(url, response.clone());
      }
      async match(url) {
        return this.#entries.get(url)?.clone();
      }
    };
    NodeCacheStorage = class {
      #caches = /* @__PURE__ */ new Map();
      async open(name) {
        let cache = this.#caches.get(name);
        if (!cache) {
          cache = new NodeCacheEntry();
          this.#caches.set(name, cache);
        }
        return cache;
      }
      async delete(name) {
        return this.#caches.delete(name);
      }
    };
    nodeCacheStorage = new NodeCacheStorage();
    HOST_RUNTIME = {
      createWorker(url) {
        return new NodeWorker(url);
      },
      workerScope: new NodeWorkerScope(),
      getOnLine() {
        return true;
      },
      getUserAgent() {
        return "Node.js";
      },
      getLocalStorage() {
        return void 0;
      },
      getCacheStorage() {
        return nodeCacheStorage;
      },
      getDevicePixelRatio() {
        return 1;
      },
      async saveScreenshot(_options) {
      },
      revokeLastScreenshotUrl() {
      },
      async loadTextFile(url) {
        return await Fs.promises.readFile(Url.fileURLToPath(url), "utf-8");
      },
      evaluateCSS(_dataValue, _customExpr) {
        return null;
      },
      removeCSSEvaluationElement() {
      }
    };
  }
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/node/node.ts
var node_exports = {};
__export(node_exports, {
  HostRuntime: () => HostRuntime_exports
});
var init_node = __esm({
  "devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/node/node.ts"() {
    "use strict";
    init_HostRuntime();
  }
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/ArrayUtilities.ts
var ArrayUtilities_exports = {};
__export(ArrayUtilities_exports, {
  DEFAULT_COMPARATOR: () => DEFAULT_COMPARATOR,
  arrayDoesNotContainNullOrUndefined: () => arrayDoesNotContainNullOrUndefined,
  assertArrayIsSorted: () => assertArrayIsSorted,
  binaryIndexOf: () => binaryIndexOf,
  insertWithComparator: () => insertWithComparator,
  intersectOrdered: () => intersectOrdered,
  lowerBound: () => lowerBound,
  mergeOrdered: () => mergeOrdered,
  nearestIndexFromBeginning: () => nearestIndexFromBeginning,
  nearestIndexFromEnd: () => nearestIndexFromEnd,
  removeElement: () => removeElement,
  sortRange: () => sortRange,
  swap: () => swap,
  upperBound: () => upperBound
});
var removeElement = (array, element, firstOnly) => {
  let index = array.indexOf(element);
  if (index === -1) {
    return false;
  }
  if (firstOnly) {
    array.splice(index, 1);
    return true;
  }
  for (let i = index + 1, n = array.length; i < n; ++i) {
    if (array[i] !== element) {
      array[index++] = array[i];
    }
  }
  array.length = index;
  return true;
};
function swap(array, i1, i2) {
  const temp = array[i1];
  array[i1] = array[i2];
  array[i2] = temp;
}
function partition(array, comparator, left, right, pivotIndex) {
  const pivotValue = array[pivotIndex];
  swap(array, right, pivotIndex);
  let storeIndex = left;
  for (let i = left; i < right; ++i) {
    if (comparator(array[i], pivotValue) < 0) {
      swap(array, storeIndex, i);
      ++storeIndex;
    }
  }
  swap(array, right, storeIndex);
  return storeIndex;
}
function quickSortRange(array, comparator, left, right, sortWindowLeft, sortWindowRight) {
  if (right <= left) {
    return;
  }
  const pivotIndex = Math.floor(Math.random() * (right - left)) + left;
  const pivotNewIndex = partition(array, comparator, left, right, pivotIndex);
  if (sortWindowLeft < pivotNewIndex) {
    quickSortRange(array, comparator, left, pivotNewIndex - 1, sortWindowLeft, sortWindowRight);
  }
  if (pivotNewIndex < sortWindowRight) {
    quickSortRange(array, comparator, pivotNewIndex + 1, right, sortWindowLeft, sortWindowRight);
  }
}
function sortRange(array, comparator, leftBound, rightBound, sortWindowLeft, sortWindowRight) {
  if (leftBound === 0 && rightBound === array.length - 1 && sortWindowLeft === 0 && sortWindowRight >= rightBound) {
    array.sort(comparator);
  } else {
    quickSortRange(array, comparator, leftBound, rightBound, sortWindowLeft, sortWindowRight);
  }
  return array;
}
var binaryIndexOf = (array, value, comparator) => {
  const index = lowerBound(array, value, comparator);
  return index < array.length && comparator(value, array[index]) === 0 ? index : -1;
};
function mergeOrIntersect(array1, array2, comparator, mergeNotIntersect) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < array1.length && j < array2.length) {
    const compareValue = comparator(array1[i], array2[j]);
    if (mergeNotIntersect || !compareValue) {
      result.push(compareValue <= 0 ? array1[i] : array2[j]);
    }
    if (compareValue <= 0) {
      i++;
    }
    if (compareValue >= 0) {
      j++;
    }
  }
  if (mergeNotIntersect) {
    while (i < array1.length) {
      result.push(array1[i++]);
    }
    while (j < array2.length) {
      result.push(array2[j++]);
    }
  }
  return result;
}
var intersectOrdered = (array1, array2, comparator) => {
  return mergeOrIntersect(array1, array2, comparator, false);
};
var mergeOrdered = (array1, array2, comparator) => {
  return mergeOrIntersect(array1, array2, comparator, true);
};
var DEFAULT_COMPARATOR = (a, b) => {
  return a < b ? -1 : a > b ? 1 : 0;
};
function lowerBound(array, needle, comparator, left, right) {
  let l = left || 0;
  let r = right !== void 0 ? right : array.length;
  while (l < r) {
    const m = l + r >> 1;
    if (comparator(needle, array[m]) > 0) {
      l = m + 1;
    } else {
      r = m;
    }
  }
  return r;
}
function insertWithComparator(array, value, comparator) {
  const index = lowerBound(array, value, comparator);
  array.splice(index, 0, value);
  return index;
}
function upperBound(array, needle, comparator, left, right) {
  let l = left || 0;
  let r = right !== void 0 ? right : array.length;
  while (l < r) {
    const m = l + r >> 1;
    if (comparator(needle, array[m]) >= 0) {
      l = m + 1;
    } else {
      r = m;
    }
  }
  return r;
}
function nearestIndex(arr, predicate, searchStart) {
  const searchFromEnd = searchStart === "END" /* END */;
  if (arr.length === 0) {
    return null;
  }
  let left = 0;
  let right = arr.length - 1;
  let pivot = 0;
  let matchesPredicate = false;
  let moveToTheRight = false;
  let middle = 0;
  do {
    middle = left + (right - left) / 2;
    pivot = searchFromEnd ? Math.ceil(middle) : Math.floor(middle);
    matchesPredicate = predicate(arr[pivot]);
    moveToTheRight = matchesPredicate === searchFromEnd;
    if (moveToTheRight) {
      left = Math.min(right, pivot + (left === pivot ? 1 : 0));
    } else {
      right = Math.max(left, pivot + (right === pivot ? -1 : 0));
    }
  } while (right !== left);
  if (!predicate(arr[left])) {
    return null;
  }
  return left;
}
function nearestIndexFromBeginning(arr, predicate) {
  return nearestIndex(arr, predicate, "BEGINNING" /* BEGINNING */);
}
function nearestIndexFromEnd(arr, predicate) {
  return nearestIndex(arr, predicate, "END" /* END */);
}
function arrayDoesNotContainNullOrUndefined(arr) {
  return !arr.includes(null) && !arr.includes(void 0);
}
function assertArrayIsSorted(arr, compareFn) {
  const comparator = compareFn || DEFAULT_COMPARATOR;
  for (let i = 0; i < arr.length - 1; i++) {
    const current = arr[i];
    const next = arr[i + 1];
    if (comparator(current, next) > 0) {
      throw new Error(`Array is not sorted at index ${i}: ${JSON.stringify(current)} > ${JSON.stringify(next)}`);
    }
  }
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/DevToolsPath.ts
var DevToolsPath_exports = {};
__export(DevToolsPath_exports, {
  EmptyEncodedPathString: () => EmptyEncodedPathString,
  EmptyRawPathString: () => EmptyRawPathString,
  EmptyUrlString: () => EmptyUrlString,
  urlString: () => urlString
});
var EmptyUrlString = "";
var urlString = (strings, ...values) => String.raw({ raw: strings }, ...values);
var EmptyRawPathString = "";
var EmptyEncodedPathString = "";

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/HostRuntime.ts
var HostRuntime_exports2 = {};
__export(HostRuntime_exports2, {
  HOST_RUNTIME: () => HOST_RUNTIME2,
  IS_BROWSER: () => IS_BROWSER,
  IS_NODE: () => IS_NODE
});
var IS_NODE = true;
var IS_BROWSER = false;
var HOST_RUNTIME2 = (await Promise.resolve().then(() => (init_node(), node_exports))).HostRuntime.HOST_RUNTIME;

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/platform/StringUtilities.ts
var StringUtilities_exports = {};
__export(StringUtilities_exports, {
  DOUBLE_QUOTE: () => DOUBLE_QUOTE,
  SINGLE_QUOTE: () => SINGLE_QUOTE,
  base64ToSize: () => base64ToSize,
  caseInsensetiveComparator: () => caseInsensetiveComparator,
  collapseWhitespace: () => collapseWhitespace,
  compare: () => compare,
  concatBase64: () => concatBase64,
  countUnmatchedLeftParentheses: () => countUnmatchedLeftParentheses,
  countWtf8Bytes: () => countWtf8Bytes,
  createPlainTextSearchRegex: () => createPlainTextSearchRegex,
  createSearchRegex: () => createSearchRegex,
  escapeCharacters: () => escapeCharacters,
  escapeForRegExp: () => escapeForRegExp,
  escapeForURLPattern: () => escapeForURLPattern,
  escapeUnicodeAsText: () => escapeUnicodeAsText,
  filterRegex: () => filterRegex,
  findIndexesOfSubString: () => findIndexesOfSubString,
  findLineEndingIndexes: () => findLineEndingIndexes,
  findUnclosedCssQuote: () => findUnclosedCssQuote,
  formatAsJSLiteral: () => formatAsJSLiteral,
  hashCode: () => hashCode,
  isExtendedKebabCase: () => isExtendedKebabCase,
  isWhitespace: () => isWhitespace,
  naturalOrderComparator: () => naturalOrderComparator,
  regexSpecialCharacters: () => regexSpecialCharacters,
  removeURLFragment: () => removeURLFragment,
  replaceControlCharacters: () => replaceControlCharacters,
  replaceLast: () => replaceLast,
  reverse: () => reverse,
  safeEscapeUnicode: () => safeEscapeUnicode,
  sprintf: () => sprintf,
  stringifyWithPrecision: () => stringifyWithPrecision,
  stripLineBreaks: () => stripLineBreaks,
  toBase64: () => toBase64,
  toKebabCase: () => toKebabCase,
  toKebabCaseKeys: () => toKebabCaseKeys,
  toLowerCaseString: () => toLowerCaseString,
  toSnakeCase: () => toSnakeCase,
  toTitleCase: () => toTitleCase,
  trimEndWithMaxLength: () => trimEndWithMaxLength,
  trimMiddle: () => trimMiddle,
  trimURL: () => trimURL,
  truncateToCodeUnitLength: () => truncateToCodeUnitLength
});
var graphemeSegmenter = null;
var escapeCharacters = (inputString, charsToEscape) => {
  let foundChar = false;
  for (let i = 0; i < charsToEscape.length; ++i) {
    if (inputString.indexOf(charsToEscape.charAt(i)) !== -1) {
      foundChar = true;
      break;
    }
  }
  if (!foundChar) {
    return String(inputString);
  }
  let result = "";
  for (let i = 0; i < inputString.length; ++i) {
    if (charsToEscape.indexOf(inputString.charAt(i)) !== -1) {
      result += "\\";
    }
    result += inputString.charAt(i);
  }
  return result;
};
var toHexadecimal = (charCode, padToLength) => {
  return charCode.toString(16).toUpperCase().padStart(padToLength, "0");
};
var escapedReplacements = /* @__PURE__ */ new Map([
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["	", "\\t"],
  ["\v", "\\v"],
  ["'", "\\'"],
  ["\\", "\\\\"],
  ["<!--", "\\x3C!--"],
  ["<script", "\\x3Cscript"],
  ["</script", "\\x3C/script"]
]);
var UNICODE_ESCAPE_SOURCE = "[\\p{Format}\\p{Surrogate}]";
var UNICODE_ESCAPE_REGEX = new RegExp(UNICODE_ESCAPE_SOURCE, "u");
var UNICODE_ESCAPE_GLOBAL_REGEX = new RegExp(UNICODE_ESCAPE_SOURCE, "gu");
var UNICODE_ESCAPE_EXCEPT_ZWSP_SOURCE = "(?![\\u200B\\u200C\\u200D])[\\p{Format}]|\\p{Surrogate}";
var UNICODE_ESCAPE_EXCEPT_ZWSP_REGEX = new RegExp(UNICODE_ESCAPE_EXCEPT_ZWSP_SOURCE, "u");
var UNICODE_ESCAPE_EXCEPT_ZWSP_GLOBAL_REGEX = new RegExp(UNICODE_ESCAPE_EXCEPT_ZWSP_SOURCE, "gu");
var escapeUnicodeAsText = (content) => {
  if (!UNICODE_ESCAPE_REGEX.test(content)) {
    return content;
  }
  return content.replaceAll(UNICODE_ESCAPE_GLOBAL_REGEX, (match) => {
    return match.split("").map((char) => "\\u" + toHexadecimal(char.charCodeAt(0), 4)).join("");
  });
};
var safeEscapeUnicode = (content) => {
  if (!UNICODE_ESCAPE_EXCEPT_ZWSP_REGEX.test(content)) {
    return content;
  }
  return content.replaceAll(UNICODE_ESCAPE_EXCEPT_ZWSP_GLOBAL_REGEX, (match) => {
    return match.split("").map((char) => "\\u" + toHexadecimal(char.charCodeAt(0), 4)).join("");
  });
};
var formatAsJSLiteral = (content) => {
  const patternsToEscape = new RegExp("(\\\\|<(?:!--|\\/?script))|(\\p{Control}|\\p{Format})|(\\p{Surrogate})", "giu");
  const patternsToEscapePlusSingleQuote = new RegExp("(\\\\|'|<(?:!--|\\/?script))|(\\p{Control}|\\p{Format})|(\\p{Surrogate})", "giu");
  const escapePattern = (match, pattern, controlChar, loneSurrogate) => {
    if (controlChar) {
      if (escapedReplacements.has(controlChar)) {
        return escapedReplacements.get(controlChar);
      }
      return controlChar.split("").map((char) => {
        const charCode = char.charCodeAt(0);
        if (controlChar.length === 1 && charCode <= 255) {
          return "\\x" + toHexadecimal(charCode, 2);
        }
        return "\\u" + toHexadecimal(charCode, 4);
      }).join("");
    }
    if (loneSurrogate) {
      const fourDigitHex = toHexadecimal(loneSurrogate.charCodeAt(0), 4);
      return "\\u" + fourDigitHex;
    }
    if (pattern) {
      if (pattern.startsWith("<")) {
        return "\\x3C" + pattern.slice(1);
      }
      return escapedReplacements.get(pattern) || "";
    }
    return match;
  };
  let escapedContent = "";
  let quote = "";
  if (!content.includes("'")) {
    quote = "'";
    escapedContent = content.replaceAll(patternsToEscape, escapePattern);
  } else if (!content.includes('"')) {
    quote = '"';
    escapedContent = content.replaceAll(patternsToEscape, escapePattern);
  } else if (!content.includes("`") && !content.includes("${")) {
    quote = "`";
    escapedContent = content.replaceAll(patternsToEscape, escapePattern);
  } else {
    quote = "'";
    escapedContent = content.replaceAll(patternsToEscapePlusSingleQuote, escapePattern);
  }
  return `${quote}${escapedContent}${quote}`;
};
var sprintf = (fmt, ...args) => {
  let argIndex = 0;
  const RE2 = /%(?:(\d+)\$)?(?:\.(\d*))?([%dfs])/g;
  return fmt.replaceAll(RE2, (_, index, precision, specifier) => {
    if (specifier === "%") {
      return "%";
    }
    if (index !== void 0) {
      argIndex = parseInt(index, 10) - 1;
      if (argIndex < 0) {
        throw new RangeError(`Invalid parameter index ${argIndex + 1}`);
      }
    }
    if (argIndex >= args.length) {
      throw new RangeError(`Expected at least ${argIndex + 1} format parameters, but only ${args.length} where given.`);
    }
    if (specifier === "s") {
      const argValue2 = String(args[argIndex++]);
      if (precision !== void 0) {
        return argValue2.substring(0, Number(precision));
      }
      return argValue2;
    }
    let argValue = Number(args[argIndex++]);
    if (isNaN(argValue)) {
      argValue = 0;
    }
    if (specifier === "d") {
      return String(Math.floor(argValue)).padStart(Number(precision), "0");
    }
    if (precision !== void 0) {
      return argValue.toFixed(Number(precision));
    }
    return String(argValue);
  });
};
var toBase64 = (inputString) => {
  function encodeBits(b) {
    return b < 26 ? b + 65 : b < 52 ? b + 71 : b < 62 ? b - 4 : b === 62 ? 43 : b === 63 ? 47 : 65;
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(inputString.toString());
  const n = data.length;
  let encoded = "";
  if (n === 0) {
    return encoded;
  }
  let shift;
  let v = 0;
  for (let i = 0; i < n; i++) {
    shift = i % 3;
    v |= data[i] << (16 >>> shift & 24);
    if (shift === 2) {
      encoded += String.fromCharCode(
        encodeBits(v >>> 18 & 63),
        encodeBits(v >>> 12 & 63),
        encodeBits(v >>> 6 & 63),
        encodeBits(v & 63)
      );
      v = 0;
    }
  }
  if (shift === 0) {
    encoded += String.fromCharCode(encodeBits(v >>> 18 & 63), encodeBits(v >>> 12 & 63), 61, 61);
  } else if (shift === 1) {
    encoded += String.fromCharCode(encodeBits(v >>> 18 & 63), encodeBits(v >>> 12 & 63), encodeBits(v >>> 6 & 63), 61);
  }
  return encoded;
};
var findIndexesOfSubString = (inputString, searchString) => {
  const matches = [];
  let i = inputString.indexOf(searchString);
  while (i !== -1) {
    matches.push(i);
    i = inputString.indexOf(searchString, i + searchString.length);
  }
  return matches;
};
var findLineEndingIndexes = (inputString) => {
  const endings = findIndexesOfSubString(inputString, "\n");
  endings.push(inputString.length);
  return endings;
};
var isWhitespace = (inputString) => {
  return /^\s*$/.test(inputString);
};
var trimURL = (url, baseURLDomain) => {
  let result = url.replace(/^(https|http|file):\/\//i, "");
  if (baseURLDomain) {
    if (result.toLowerCase().startsWith(baseURLDomain.toLowerCase())) {
      result = result.substr(baseURLDomain.length);
    }
  }
  return result;
};
var collapseWhitespace = (inputString) => {
  return inputString.replace(/[\s\xA0]+/g, " ");
};
var reverse = (inputString) => {
  return inputString.split("").reverse().join("");
};
var replaceControlCharacters = (inputString) => {
  return inputString.replace(/[\0-\x08\x0B\f\x0E-\x1F\x80-\x9F]/g, "\uFFFD");
};
var countWtf8Bytes = (inputString) => {
  let count = 0;
  for (let i = 0; i < inputString.length; i++) {
    const c = inputString.charCodeAt(i);
    if (c <= 127) {
      count++;
    } else if (c <= 2047) {
      count += 2;
    } else if (c < 55296 || 57343 < c) {
      count += 3;
    } else {
      if (c <= 56319 && i + 1 < inputString.length) {
        const next = inputString.charCodeAt(i + 1);
        if (56320 <= next && next <= 57343) {
          count += 4;
          i++;
          continue;
        }
      }
      count += 3;
    }
  }
  return count;
};
var stripLineBreaks = (inputStr) => {
  return inputStr.replace(/(\r)?\n/g, "");
};
var EXTENDED_KEBAB_CASE_REGEXP = /^([a-z0-9]+(?:-[a-z0-9]+)*\.)*[a-z0-9]+(?:-[a-z0-9]+)*$/;
var isExtendedKebabCase = (inputStr) => {
  return EXTENDED_KEBAB_CASE_REGEXP.test(inputStr);
};
var toTitleCase = (inputStr) => {
  return inputStr.substring(0, 1).toUpperCase() + inputStr.substring(1);
};
var removeURLFragment = (inputStr) => {
  const url = new URL(inputStr);
  url.hash = "";
  return url.toString();
};
var SPECIAL_REGEX_CHARACTERS = "^[]{}()\\.^$*+?|-,";
var SPECIAL_URL_PATTERN_CHARACTERS = "?+*(){}\\:";
var regexSpecialCharacters = function() {
  return SPECIAL_REGEX_CHARACTERS;
};
var filterRegex = function(query) {
  let regexString = "^(?:.*\\0)?";
  for (let i = 0; i < query.length; ++i) {
    let c = query.charAt(i);
    if (SPECIAL_REGEX_CHARACTERS.indexOf(c) !== -1) {
      c = "\\" + c;
    }
    regexString += "[^\\0" + c + "]*" + c;
  }
  return new RegExp(regexString, "i");
};
var createSearchRegex = function(query, caseSensitive, isRegex, matchWholeWord = false) {
  const regexFlags = caseSensitive ? "g" : "gi";
  let regexObject;
  if (isRegex) {
    try {
      regexObject = new RegExp(query, regexFlags);
    } catch {
    }
  }
  if (!regexObject) {
    regexObject = createPlainTextSearchRegex(query, regexFlags);
  }
  if (matchWholeWord && regexObject) {
    regexObject = new RegExp(`\\b${regexObject.source}\\b`, regexFlags);
  }
  return regexObject;
};
var caseInsensetiveComparator = function(a, b) {
  a = a.toUpperCase();
  b = b.toUpperCase();
  if (a === b) {
    return 0;
  }
  return a > b ? 1 : -1;
};
var hashCode = function(string) {
  if (!string) {
    return 0;
  }
  const p = (1 << 30) * 4 - 5;
  const z = 1345575271;
  const z2 = 1506996573;
  let s = 0;
  let zi = 1;
  for (let i = 0; i < string.length; i++) {
    const xi = string.charCodeAt(i) * z2;
    s = (s + zi * xi) % p;
    zi = zi * z % p;
  }
  s = (s + zi * (p - 1)) % p;
  return Math.abs(s | 0);
};
var compare = (a, b) => {
  if (a > b) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  return 0;
};
var trimMiddle = (str, maxLength) => {
  if (str.length <= maxLength) {
    return str;
  }
  const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
  const ellipsis = "\u2026";
  const ellipsisLength = 1;
  if (maxLength <= ellipsisLength) {
    return ellipsis;
  }
  const freeSpace = maxLength - ellipsisLength;
  const leftCount = Math.ceil(freeSpace / 2);
  const rightCount = Math.floor(freeSpace / 2);
  let currentGraphemeCount = 0;
  let leftEndIndex = 0;
  const rightIndexBuffer = [];
  for (const { segment, index } of segmenter.segment(str)) {
    currentGraphemeCount++;
    if (currentGraphemeCount === leftCount) {
      leftEndIndex = index + segment.length;
    }
    if (rightCount > 0) {
      rightIndexBuffer.push(index);
      if (rightIndexBuffer.length > rightCount) {
        rightIndexBuffer.shift();
      }
    }
  }
  if (currentGraphemeCount <= maxLength) {
    return str;
  }
  const rightStartIndex = rightCount > 0 ? rightIndexBuffer[0] : str.length;
  return str.slice(0, leftEndIndex) + ellipsis + str.slice(rightStartIndex);
};
var trimEndWithMaxLength = (str, maxLength) => {
  if (str.length <= maxLength) {
    return str;
  }
  const ellipsis = "\u2026";
  const ellipsisLength = 1;
  const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
  const iterator = segmenter.segment(str)[Symbol.iterator]();
  let lastSegmentIndex = 0;
  for (let i = 0; i <= maxLength - ellipsisLength; i++) {
    const result = iterator.next();
    if (result.done) {
      return str;
    }
    lastSegmentIndex = result.value.index;
  }
  for (let i = 0; i < ellipsisLength; i++) {
    if (iterator.next().done) {
      return str;
    }
  }
  return str.slice(0, lastSegmentIndex) + ellipsis;
};
var truncateToCodeUnitLength = (str, maxCodeUnits) => {
  if (isNaN(maxCodeUnits) || maxCodeUnits <= 0) {
    return "";
  }
  if (str.length <= maxCodeUnits) {
    return str;
  }
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
  }
  let lastSafeIndex = 0;
  for (const { index, segment } of graphemeSegmenter.segment(str)) {
    if (index + segment.length > maxCodeUnits) {
      break;
    }
    lastSafeIndex = index + segment.length;
  }
  return str.slice(0, lastSafeIndex);
};
var escapeForRegExp = (str) => {
  return escapeCharacters(str, SPECIAL_REGEX_CHARACTERS);
};
var escapeForURLPattern = (text) => {
  return escapeCharacters(text, SPECIAL_URL_PATTERN_CHARACTERS);
};
var naturalOrderComparator = (a, b) => {
  const chunk = /^\d+|^\D+/;
  let chunkA, chunkB, numA, numB;
  while (true) {
    if (a) {
      if (!b) {
        return 1;
      }
    } else {
      if (b) {
        return -1;
      }
      return 0;
    }
    chunkA = a.match(chunk)[0];
    chunkB = b.match(chunk)[0];
    numA = !Number.isNaN(Number(chunkA));
    numB = !Number.isNaN(Number(chunkB));
    if (numA && !numB) {
      return -1;
    }
    if (numB && !numA) {
      return 1;
    }
    if (numA && numB) {
      const diff = Number(chunkA) - Number(chunkB);
      if (diff) {
        return diff;
      }
      if (chunkA.length !== chunkB.length) {
        if (!Number(chunkA) && !Number(chunkB)) {
          return chunkA.length - chunkB.length;
        }
        return chunkB.length - chunkA.length;
      }
    } else if (chunkA !== chunkB) {
      return chunkA < chunkB ? -1 : 1;
    }
    a = a.substring(chunkA.length);
    b = b.substring(chunkB.length);
  }
};
var base64ToSize = function(content) {
  if (!content) {
    return 0;
  }
  let size = content.length * 3 / 4;
  if (content[content.length - 1] === "=") {
    size--;
  }
  if (content.length > 1 && content[content.length - 2] === "=") {
    size--;
  }
  return size;
};
var SINGLE_QUOTE = "'";
var DOUBLE_QUOTE = '"';
var BACKSLASH = "\\";
var findUnclosedCssQuote = function(str) {
  let unmatchedQuote = "";
  for (let i = 0; i < str.length; ++i) {
    const char = str[i];
    if (char === BACKSLASH) {
      i++;
      continue;
    }
    if (char === SINGLE_QUOTE || char === DOUBLE_QUOTE) {
      if (unmatchedQuote === char) {
        unmatchedQuote = "";
      } else if (unmatchedQuote === "") {
        unmatchedQuote = char;
      }
    }
  }
  return unmatchedQuote;
};
var countUnmatchedLeftParentheses = (str) => {
  const stringLiteralRegex = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  const strWithoutStrings = str.replace(stringLiteralRegex, "");
  let unmatchedCount = 0;
  for (const c of strWithoutStrings) {
    if (c === "(") {
      unmatchedCount++;
    } else if (c === ")" && unmatchedCount > 0) {
      unmatchedCount--;
    }
  }
  return unmatchedCount;
};
var createPlainTextSearchRegex = function(query, flags) {
  let regex = "";
  for (let i = 0; i < query.length; ++i) {
    const c = query.charAt(i);
    if (regexSpecialCharacters().indexOf(c) !== -1) {
      regex += "\\";
    }
    regex += c;
  }
  return new RegExp(regex, flags || "");
};
var toLowerCaseString = function(input) {
  return input.toLowerCase();
};
var WORD = /[A-Z]{2,}(?=[A-Z0-9][a-z0-9]+|\b|_)|[A-Za-z][0-9]+[a-z]?|[A-Z]?[a-z]+|[0-9][A-Za-z]+|[A-Z]|[0-9]+|[.]/g;
var toKebabCase = function(input) {
  return input.match?.(WORD)?.map((w) => w.toLowerCase()).join("-").replaceAll("-.-", ".") || input;
};
function toKebabCaseKeys(settingValue) {
  return Object.fromEntries(Object.entries(settingValue).map(([key, value]) => [toKebabCase(key), value]));
}
function toSnakeCase(text) {
  if (!text) {
    return "";
  }
  const result = text.replace(new RegExp("(\\p{L})(\\p{N})", "gu"), "$1_$2").replace(new RegExp("(\\p{Lu}+)(\\p{Lu}\\p{Ll})", "gu"), "$1_$2").replace(new RegExp("(\\p{Ll}|\\p{N})(\\p{Lu})", "gu"), "$1_$2").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  return result;
}
var replaceLast = function(input, search, replacement) {
  const replacementStartIndex = input.lastIndexOf(search);
  if (replacementStartIndex === -1) {
    return input;
  }
  return input.slice(0, replacementStartIndex) + input.slice(replacementStartIndex).replace(search, replacement);
};
var stringifyWithPrecision = function stringifyWithPrecision2(s, precision = 2) {
  if (precision === 0) {
    return s.toFixed(0);
  }
  const string = s.toFixed(precision).replace(/\.?0*$/, "");
  return string === "-0" ? "0" : string;
};
var concatBase64 = function(lhs, rhs) {
  if (lhs.length === 0 || !lhs.endsWith("=")) {
    return lhs + rhs;
  }
  const lhsLeaveAsIs = lhs.substring(0, lhs.length - 4);
  const lhsToDecode = lhs.substring(lhs.length - 4);
  return lhsLeaveAsIs + globalThis.btoa(globalThis.atob(lhsToDecode) + globalThis.atob(rhs));
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/entrypoints/wasmparser_worker/WasmParserWorker.ts
var WasmParserWorker_exports = {};
__export(WasmParserWorker_exports, {
  dissambleWASM: () => dissambleWASM
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/Base64.ts
var Base64_exports = {};
__export(Base64_exports, {
  BASE64_CHARS: () => BASE64_CHARS,
  BASE64_CODES: () => BASE64_CODES,
  decode: () => decode,
  encode: () => encode
});
var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var BASE64_CODES = new Uint8Array(123);
for (let index = 0; index < BASE64_CHARS.length; ++index) {
  BASE64_CODES[BASE64_CHARS.charCodeAt(index)] = index;
}
function decode(input) {
  let bytesLength = input.length * 3 / 4 >>> 0;
  if (input.charCodeAt(input.length - 2) === 61) {
    bytesLength -= 2;
  } else if (input.charCodeAt(input.length - 1) === 61) {
    bytesLength -= 1;
  }
  const bytes = new Uint8Array(bytesLength);
  for (let index = 0, offset = 0; index < input.length; index += 4) {
    const a = BASE64_CODES[input.charCodeAt(index + 0)];
    const b = BASE64_CODES[input.charCodeAt(index + 1)];
    const c = BASE64_CODES[input.charCodeAt(index + 2)];
    const d = BASE64_CODES[input.charCodeAt(index + 3)];
    bytes[offset++] = a << 2 | b >> 4;
    bytes[offset++] = (b & 15) << 4 | c >> 2;
    bytes[offset++] = (c & 3) << 6 | d & 63;
  }
  return bytes;
}
async function encode(input) {
  const maybeFileReader = globalThis["FileReader"];
  if (!maybeFileReader) {
    const blob = new Blob([input]);
    const arrayBuffer = await blob.arrayBuffer();
    return globalThis.Buffer.from(arrayBuffer).toString("base64");
  }
  return await new Promise((resolve, reject) => {
    const reader = new maybeFileReader();
    reader.onerror = () => reject(new Error("failed to convert to base64: internal error"));
    reader.onload = () => {
      if (reader.result === "") {
        reject(new Error("failed to convert to base64: input too large to encode as base64 string"));
        return;
      }
      const blobAsUrl = reader.result;
      const index = blobAsUrl.indexOf(",");
      const base64 = blobAsUrl.slice(index + 1);
      resolve(base64);
    };
    reader.readAsDataURL(new Blob([input]));
  });
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/ColorConverter.ts
var D50_X = 0.9642;
var D50_Y = 1;
var D50_Z = 0.8251;
var Vector3 = class {
  values = [0, 0, 0];
  constructor(values) {
    if (values) {
      this.values = values;
    }
  }
};
var Matrix3x3 = class {
  values = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  constructor(values) {
    if (values) {
      this.values = values;
    }
  }
  multiply(other) {
    const dst = new Vector3();
    for (let row = 0; row < 3; ++row) {
      dst.values[row] = this.values[row][0] * other.values[0] + this.values[row][1] * other.values[1] + this.values[row][2] * other.values[2];
    }
    return dst;
  }
};
var TransferFunction = class {
  g;
  a;
  b;
  c;
  d;
  e;
  f;
  constructor(g, a, b = 0, c = 0, d = 0, e = 0, f = 0) {
    this.g = g;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }
  eval(val) {
    const sign = val < 0 ? -1 : 1;
    const abs = val * sign;
    if (abs < this.d) {
      return sign * (this.c * abs + this.f);
    }
    return sign * (Math.pow(this.a * abs + this.b, this.g) + this.e);
  }
};
var NAMED_TRANSFER_FN = {
  sRGB: new TransferFunction(2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0),
  sRGB_INVERSE: new TransferFunction(0.416667, 1.13728, -0, 12.92, 31308e-7, -0.0549698, -0),
  proPhotoRGB: new TransferFunction(1.8, 1),
  proPhotoRGB_INVERSE: new TransferFunction(0.555556, 1, -0, 0, 0, 0, 0),
  k2Dot2: new TransferFunction(2.2, 1),
  k2Dot2_INVERSE: new TransferFunction(0.454545, 1),
  rec2020: new TransferFunction(2.22222, 0.909672, 0.0903276, 0.222222, 0.0812429, 0, 0),
  rec2020_INVERSE: new TransferFunction(0.45, 1.23439, -0, 4.5, 0.018054, -0.0993195, -0)
};
var NAMED_GAMUTS = {
  sRGB: new Matrix3x3([
    [0.436065674, 0.385147095, 0.143066406],
    [0.222488403, 0.716873169, 0.06060791],
    [0.013916016, 0.097076416, 0.714096069]
  ]),
  sRGB_INVERSE: new Matrix3x3([
    [3.134112151374599, -1.6173924597114966, -0.4906334036481285],
    [-0.9787872938826594, 1.9162795854799963, 0.0334547139520088],
    [0.07198304248352326, -0.2289858493321844, 1.4053851325241447]
  ]),
  displayP3: new Matrix3x3([
    [0.515102, 0.291965, 0.157153],
    [0.241182, 0.692236, 0.0665819],
    [-104941e-8, 0.0418818, 0.784378]
  ]),
  displayP3_INVERSE: new Matrix3x3([
    [2.404045155982687, -0.9898986932663839, -0.3976317191366333],
    [-0.8422283799266768, 1.7988505115115485, 0.016048170293157416],
    [0.04818705979712955, -0.09737385156228891, 1.2735066448052303]
  ]),
  adobeRGB: new Matrix3x3([
    [0.60974, 0.20528, 0.14919],
    [0.31111, 0.62567, 0.06322],
    [0.01947, 0.06087, 0.74457]
  ]),
  adobeRGB_INVERSE: new Matrix3x3([
    [1.9625385510109137, -0.6106892546501431, -0.3413827467482388],
    [-0.9787580455521, 1.9161624707082339, 0.03341676594241408],
    [0.028696263137883395, -0.1406807819331586, 1.349252109991369]
  ]),
  rec2020: new Matrix3x3([
    [0.673459, 0.165661, 0.1251],
    [0.279033, 0.675338, 0.0456288],
    [-193139e-8, 0.0299794, 0.797162]
  ]),
  rec2020_INVERSE: new Matrix3x3([
    [1.647275201661012, -0.3936024771460771, -0.23598028884792507],
    [-0.6826176165196962, 1.647617775014935, 0.01281626807852422],
    [0.029662725298529837, -0.06291668721366285, 1.2533964313435522]
  ]),
  xyz: new Matrix3x3([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ])
};
function degToRad(deg) {
  return deg * (Math.PI / 180);
}
function radToDeg(rad) {
  return rad * (180 / Math.PI);
}
function applyTransferFns(fn, r, g, b) {
  return [fn.eval(r), fn.eval(g), fn.eval(b)];
}
var OKLAB_TO_LMS_MATRIX = new Matrix3x3([
  [0.9999999984505198, 0.39633779217376786, 0.2158037580607588],
  [1.0000000088817609, -0.10556134232365635, -0.06385417477170591],
  [1.0000000546724108, -0.08948418209496575, -1.2914855378640917]
]);
var LMS_TO_OKLAB_MATRIX = new Matrix3x3([
  [0.2104542553, 0.7936177849999999, -0.0040720468],
  [1.9779984951000003, -2.4285922049999997, 0.4505937099000001],
  [0.025904037099999982, 0.7827717662, -0.8086757660000001]
]);
var XYZ_TO_LMS_MATRIX = new Matrix3x3([
  [0.8190224432164319, 0.3619062562801221, -0.12887378261216414],
  [0.0329836671980271, 0.9292868468965546, 0.03614466816999844],
  [0.048177199566046255, 0.26423952494422764, 0.6335478258136937]
]);
var LMS_TO_XYZ_MATRIX = new Matrix3x3([
  [1.226879873374156, -0.5578149965554814, 0.2813910501772159],
  [-0.040575762624313734, 1.1122868293970596, -0.07171106666151703],
  [-0.07637294974672144, -0.4214933239627915, 1.586924024427242]
]);
var PRO_PHOTO_TO_XYZD50_MATRIX = new Matrix3x3([
  [0.7976700747153241, 0.13519395152800417, 0.03135596341127167],
  [0.28803902352472205, 0.7118744007923554, 8661179538844252e-20],
  [2739876695467402e-22, -14405226518969991e-22, 0.825211112593861]
]);
var XYZD50_TO_PRO_PHOTO_MATRIX = new Matrix3x3([
  [1.3459533710138858, -0.25561367037652133, -0.051116041522131374],
  [-0.544600415668951, 1.5081687311475767, 0.020535163968720935],
  [-13975622054109725e-22, 2717590904589903e-21, 1.2118111696814942]
]);
var XYZD65_TO_XYZD50_MATRIX = new Matrix3x3([
  [1.0478573189120088, 0.022907374491829943, -0.050162247377152525],
  [0.029570500050499514, 0.9904755577034089, -0.017061518194840468],
  [-0.00924047197558879, 0.015052921526981566, 0.7519708530777581]
]);
var XYZD50_TO_XYZD65_MATRIX = new Matrix3x3([
  [0.9555366447632887, -0.02306009252137888, 0.06321844147263304],
  [-0.028315378228764922, 1.009951351591575, 0.021026001591792402],
  [0.012308773293784308, -0.02050053471777469, 1.3301947294775631]
]);
var ColorConverter = class _ColorConverter {
  static labToXyzd50(l, a, b) {
    let y = (l + 16) / 116;
    let x = y + a / 500;
    let z = y - b / 200;
    function labInverseTransferFunction(t) {
      const delta = 24 / 116;
      if (t <= delta) {
        return 108 / 841 * (t - 16 / 116);
      }
      return t * t * t;
    }
    x = labInverseTransferFunction(x) * D50_X;
    y = labInverseTransferFunction(y) * D50_Y;
    z = labInverseTransferFunction(z) * D50_Z;
    return [x, y, z];
  }
  static xyzd50ToLab(x, y, z) {
    function labTransferFunction(t) {
      const deltaLimit = 24 / 116 * (24 / 116) * (24 / 116);
      if (t <= deltaLimit) {
        return 841 / 108 * t + 16 / 116;
      }
      return Math.pow(t, 1 / 3);
    }
    x = labTransferFunction(x / D50_X);
    y = labTransferFunction(y / D50_Y);
    z = labTransferFunction(z / D50_Z);
    const l = 116 * y - 16;
    const a = 500 * (x - y);
    const b = 200 * (y - z);
    return [l, a, b];
  }
  static oklabToXyzd65(l, a, b) {
    const labInput = new Vector3([l, a, b]);
    const lmsIntermediate = OKLAB_TO_LMS_MATRIX.multiply(labInput);
    lmsIntermediate.values[0] = lmsIntermediate.values[0] * lmsIntermediate.values[0] * lmsIntermediate.values[0];
    lmsIntermediate.values[1] = lmsIntermediate.values[1] * lmsIntermediate.values[1] * lmsIntermediate.values[1];
    lmsIntermediate.values[2] = lmsIntermediate.values[2] * lmsIntermediate.values[2] * lmsIntermediate.values[2];
    const xyzOutput = LMS_TO_XYZ_MATRIX.multiply(lmsIntermediate);
    return xyzOutput.values;
  }
  static xyzd65ToOklab(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const lmsIntermediate = XYZ_TO_LMS_MATRIX.multiply(xyzInput);
    lmsIntermediate.values[0] = Math.cbrt(lmsIntermediate.values[0]);
    lmsIntermediate.values[1] = Math.cbrt(lmsIntermediate.values[1]);
    lmsIntermediate.values[2] = Math.cbrt(lmsIntermediate.values[2]);
    const labOutput = LMS_TO_OKLAB_MATRIX.multiply(lmsIntermediate);
    return [labOutput.values[0], labOutput.values[1], labOutput.values[2]];
  }
  static lchToLab(l, c, h) {
    if (h === void 0) {
      return [l, 0, 0];
    }
    return [l, c * Math.cos(degToRad(h)), c * Math.sin(degToRad(h))];
  }
  static labToLch(l, a, b) {
    return [l, Math.sqrt(a * a + b * b), radToDeg(Math.atan2(b, a))];
  }
  static displayP3ToXyzd50(r, g, b) {
    const [mappedR, mappedG, mappedB] = applyTransferFns(NAMED_TRANSFER_FN.sRGB, r, g, b);
    const rgbInput = new Vector3([mappedR, mappedG, mappedB]);
    const xyzOutput = NAMED_GAMUTS.displayP3.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToDisplayP3(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbOutput = NAMED_GAMUTS.displayP3_INVERSE.multiply(xyzInput);
    return applyTransferFns(
      NAMED_TRANSFER_FN.sRGB_INVERSE,
      rgbOutput.values[0],
      rgbOutput.values[1],
      rgbOutput.values[2]
    );
  }
  static displayP3LinearToXyzd50(r, g, b) {
    const rgbInput = new Vector3([r, g, b]);
    const xyzOutput = NAMED_GAMUTS.displayP3.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToDisplayP3Linear(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbResult = NAMED_GAMUTS.displayP3_INVERSE.multiply(xyzInput);
    return rgbResult.values;
  }
  static proPhotoToXyzd50(r, g, b) {
    const [mappedR, mappedG, mappedB] = applyTransferFns(NAMED_TRANSFER_FN.proPhotoRGB, r, g, b);
    const rgbInput = new Vector3([mappedR, mappedG, mappedB]);
    const xyzOutput = PRO_PHOTO_TO_XYZD50_MATRIX.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToProPhoto(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbOutput = XYZD50_TO_PRO_PHOTO_MATRIX.multiply(xyzInput);
    return applyTransferFns(
      NAMED_TRANSFER_FN.proPhotoRGB_INVERSE,
      rgbOutput.values[0],
      rgbOutput.values[1],
      rgbOutput.values[2]
    );
  }
  static adobeRGBToXyzd50(r, g, b) {
    const [mappedR, mappedG, mappedB] = applyTransferFns(NAMED_TRANSFER_FN.k2Dot2, r, g, b);
    const rgbInput = new Vector3([mappedR, mappedG, mappedB]);
    const xyzOutput = NAMED_GAMUTS.adobeRGB.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToAdobeRGB(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbOutput = NAMED_GAMUTS.adobeRGB_INVERSE.multiply(xyzInput);
    return applyTransferFns(
      NAMED_TRANSFER_FN.k2Dot2_INVERSE,
      rgbOutput.values[0],
      rgbOutput.values[1],
      rgbOutput.values[2]
    );
  }
  static rec2020ToXyzd50(r, g, b) {
    const [mappedR, mappedG, mappedB] = applyTransferFns(NAMED_TRANSFER_FN.rec2020, r, g, b);
    const rgbInput = new Vector3([mappedR, mappedG, mappedB]);
    const xyzOutput = NAMED_GAMUTS.rec2020.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToRec2020(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbOutput = NAMED_GAMUTS.rec2020_INVERSE.multiply(xyzInput);
    return applyTransferFns(
      NAMED_TRANSFER_FN.rec2020_INVERSE,
      rgbOutput.values[0],
      rgbOutput.values[1],
      rgbOutput.values[2]
    );
  }
  static xyzd50ToD65(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const xyzOutput = XYZD50_TO_XYZD65_MATRIX.multiply(xyzInput);
    return xyzOutput.values;
  }
  static xyzd65ToD50(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const xyzOutput = XYZD65_TO_XYZD50_MATRIX.multiply(xyzInput);
    return xyzOutput.values;
  }
  static xyzd50TosRGBLinear(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbResult = NAMED_GAMUTS.sRGB_INVERSE.multiply(xyzInput);
    return rgbResult.values;
  }
  static srgbLinearToXyzd50(r, g, b) {
    const rgbInput = new Vector3([r, g, b]);
    const xyzOutput = NAMED_GAMUTS.sRGB.multiply(rgbInput);
    return xyzOutput.values;
  }
  static srgbToXyzd50(r, g, b) {
    const [mappedR, mappedG, mappedB] = applyTransferFns(NAMED_TRANSFER_FN.sRGB, r, g, b);
    const rgbInput = new Vector3([mappedR, mappedG, mappedB]);
    const xyzOutput = NAMED_GAMUTS.sRGB.multiply(rgbInput);
    return xyzOutput.values;
  }
  static xyzd50ToSrgb(x, y, z) {
    const xyzInput = new Vector3([x, y, z]);
    const rgbOutput = NAMED_GAMUTS.sRGB_INVERSE.multiply(xyzInput);
    return applyTransferFns(
      NAMED_TRANSFER_FN.sRGB_INVERSE,
      rgbOutput.values[0],
      rgbOutput.values[1],
      rgbOutput.values[2]
    );
  }
  static oklchToXyzd50(lInput, c, h) {
    const [l, a, b] = _ColorConverter.lchToLab(lInput, c, h);
    const [x65, y65, z65] = _ColorConverter.oklabToXyzd65(l, a, b);
    return _ColorConverter.xyzd65ToD50(x65, y65, z65);
  }
  static xyzd50ToOklch(x, y, z) {
    const [x65, y65, z65] = _ColorConverter.xyzd50ToD65(x, y, z);
    const [l, a, b] = _ColorConverter.xyzd65ToOklab(x65, y65, z65);
    return _ColorConverter.labToLch(l, a, b);
  }
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/ColorUtils.ts
function blendColors(fgRGBA, bgRGBA) {
  const alpha = fgRGBA[3];
  return [
    (1 - alpha) * bgRGBA[0] + alpha * fgRGBA[0],
    (1 - alpha) * bgRGBA[1] + alpha * fgRGBA[1],
    (1 - alpha) * bgRGBA[2] + alpha * fgRGBA[2],
    alpha + bgRGBA[3] * (1 - alpha)
  ];
}
function rgbToHue([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;
  let h;
  if (min === max) {
    h = 0;
  } else if (r === max) {
    h = (1 / 6 * (g - b) / diff + 1) % 1;
  } else if (g === max) {
    h = 1 / 6 * (b - r) / diff + 1 / 3;
  } else {
    h = 1 / 6 * (r - g) / diff + 2 / 3;
  }
  return h;
}
function rgbToHsl(rgb) {
  const [h, s, l] = rgbaToHsla([...rgb, void 0]);
  return [h, s, l];
}
function rgbaToHsla([r, g, b, a]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;
  const sum = max + min;
  const h = rgbToHue([r, g, b]);
  const l = 0.5 * sum;
  let s;
  if (l === 0) {
    s = 0;
  } else if (l === 1) {
    s = 0;
  } else if (l <= 0.5) {
    s = diff / sum;
  } else {
    s = diff / (2 - sum);
  }
  return [h, s, l, a];
}
function rgbToHwb(rgb) {
  const [h, w, b] = rgbaToHwba([...rgb, void 0]);
  return [h, w, b];
}
function rgbaToHwba([r, g, b, a]) {
  const h = rgbToHue([r, g, b]);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return [h, min, 1 - max, a];
}
var contrastAPCALookupTable = [
  // See https://github.com/Myndex/SAPC-APCA
  // font size in px | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 weights
  [12, -1, -1, -1, -1, 100, 90, 80, -1, -1],
  [14, -1, -1, -1, 100, 90, 80, 60, 60, -1],
  [16, -1, -1, 100, 90, 80, 60, 55, 50, 50],
  [18, -1, -1, 90, 80, 60, 55, 50, 40, 40],
  [24, -1, 100, 80, 60, 55, 50, 40, 38, 35],
  [30, -1, 90, 70, 55, 50, 40, 38, 35, 40],
  [36, -1, 80, 60, 50, 40, 38, 35, 30, 25],
  [48, 100, 70, 55, 40, 38, 35, 30, 25, 20],
  [60, 90, 60, 50, 38, 35, 30, 25, 20, 20],
  [72, 80, 55, 40, 35, 30, 25, 20, 20, 20],
  [96, 70, 50, 35, 30, 25, 20, 20, 20, 20],
  [120, 60, 40, 30, 25, 20, 20, 20, 20, 20]
];
contrastAPCALookupTable.reverse();

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/Color.ts
function normalizeHue(hue) {
  return (hue % 360 + 360) % 360;
}
function parseAngle(angleText) {
  const angle = angleText.replace(/(deg|g?rad|turn)$/, "");
  if (isNaN(angle) || angleText.match(/\s+(deg|g?rad|turn)/)) {
    return null;
  }
  const number = parseFloat(angle);
  if (angleText.includes("turn")) {
    return number * 360;
  }
  if (angleText.includes("grad")) {
    return number * 9 / 10;
  }
  if (angleText.includes("rad")) {
    return number * 180 / Math.PI;
  }
  return number;
}
function getColorSpace(colorSpaceText) {
  switch (colorSpaceText) {
    case "srgb" /* SRGB */:
      return "srgb" /* SRGB */;
    case "srgb-linear" /* SRGB_LINEAR */:
      return "srgb-linear" /* SRGB_LINEAR */;
    case "display-p3" /* DISPLAY_P3 */:
      return "display-p3" /* DISPLAY_P3 */;
    case "display-p3-linear" /* DISPLAY_P3_LINEAR */:
      return "display-p3-linear" /* DISPLAY_P3_LINEAR */;
    case "a98-rgb" /* A98_RGB */:
      return "a98-rgb" /* A98_RGB */;
    case "prophoto-rgb" /* PROPHOTO_RGB */:
      return "prophoto-rgb" /* PROPHOTO_RGB */;
    case "rec2020" /* REC_2020 */:
      return "rec2020" /* REC_2020 */;
    case "xyz" /* XYZ */:
      return "xyz" /* XYZ */;
    case "xyz-d50" /* XYZ_D50 */:
      return "xyz-d50" /* XYZ_D50 */;
    case "xyz-d65" /* XYZ_D65 */:
      return "xyz-d65" /* XYZ_D65 */;
  }
  return null;
}
function mapPercentToRange(percent, range) {
  const sign = Math.sign(percent);
  const absPercent = Math.abs(percent);
  const [outMin, outMax] = range;
  return sign * (absPercent * (outMax - outMin) / 100 + outMin);
}
function clamp(value, { min, max }) {
  if (value === null) {
    return value;
  }
  if (min !== void 0) {
    value = Math.max(value, min);
  }
  if (max !== void 0) {
    value = Math.min(value, max);
  }
  return value;
}
function parsePercentage(value, range) {
  if (!value.endsWith("%")) {
    return null;
  }
  const percentage = parseFloat(value.substr(0, value.length - 1));
  return isNaN(percentage) ? null : mapPercentToRange(percentage, range);
}
function parseNumber(value) {
  const number = parseFloat(value);
  return isNaN(number) ? null : number;
}
function parseAlpha(value) {
  if (value === void 0) {
    return null;
  }
  return clamp(parsePercentage(value, [0, 1]) ?? parseNumber(value), { min: 0, max: 1 });
}
function parsePercentOrNumber(value, range = [0, 1]) {
  if (isNaN(value.replace("%", ""))) {
    return null;
  }
  const parsed = parseFloat(value);
  if (value.indexOf("%") !== -1) {
    if (value.indexOf("%") !== value.length - 1) {
      return null;
    }
    return mapPercentToRange(parsed, range);
  }
  return parsed;
}
function parseRgbNumeric(value) {
  const parsed = parsePercentOrNumber(value);
  if (parsed === null) {
    return null;
  }
  if (value.indexOf("%") !== -1) {
    return parsed;
  }
  return parsed / 255;
}
function parseHueNumeric(value) {
  const angle = value.replace(/(deg|g?rad|turn)$/, "");
  if (isNaN(angle) || value.match(/\s+(deg|g?rad|turn)/)) {
    return null;
  }
  const number = parseFloat(angle);
  if (value.indexOf("turn") !== -1) {
    return number % 1;
  }
  if (value.indexOf("grad") !== -1) {
    return number / 400 % 1;
  }
  if (value.indexOf("rad") !== -1) {
    return number / (2 * Math.PI) % 1;
  }
  return number / 360 % 1;
}
function parseSatLightNumeric(value) {
  if (value.indexOf("%") !== value.length - 1 || isNaN(value.replace("%", ""))) {
    return null;
  }
  const parsed = parseFloat(value);
  return parsed / 100;
}
function parseAlphaNumeric(value) {
  return parsePercentOrNumber(value);
}
function hsva2hsla(hsva) {
  const h = hsva[0];
  let s = hsva[1];
  const v = hsva[2];
  const t = (2 - s) * v;
  if (v === 0 || s === 0) {
    s = 0;
  } else {
    s *= v / (t < 1 ? t : 2 - t);
  }
  return [h, s, t / 2, hsva[3]];
}
function hsl2rgb(hsl) {
  const h = hsl[0];
  let s = hsl[1];
  const l = hsl[2];
  function hue2rgb(p2, q2, h2) {
    if (h2 < 0) {
      h2 += 1;
    } else if (h2 > 1) {
      h2 -= 1;
    }
    if (h2 * 6 < 1) {
      return p2 + (q2 - p2) * h2 * 6;
    }
    if (h2 * 2 < 1) {
      return q2;
    }
    if (h2 * 3 < 2) {
      return p2 + (q2 - p2) * (2 / 3 - h2) * 6;
    }
    return p2;
  }
  if (s < 0) {
    s = 0;
  }
  let q;
  if (l <= 0.5) {
    q = l * (1 + s);
  } else {
    q = l + s - l * s;
  }
  const p = 2 * l - q;
  const tr = h + 1 / 3;
  const tg = h;
  const tb = h - 1 / 3;
  return [hue2rgb(p, q, tr), hue2rgb(p, q, tg), hue2rgb(p, q, tb), hsl[3]];
}
function hwb2rgb(hwb) {
  const h = hwb[0];
  const w = hwb[1];
  const b = hwb[2];
  const whiteRatio = w / (w + b);
  let result = [whiteRatio, whiteRatio, whiteRatio, hwb[3]];
  if (w + b < 1) {
    result = hsl2rgb([h, 1, 0.5, hwb[3]]);
    for (let i = 0; i < 3; ++i) {
      result[i] += w - (w + b) * result[i];
    }
  }
  return result;
}
function hsva2rgba(hsva) {
  return hsl2rgb(hsva2hsla(hsva));
}
var EPSILON = 0.01;
var WIDE_RANGE_EPSILON = 1;
var STRICT_EPSILON = 1e-4;
function equals(a, b, accuracy = EPSILON) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (const i in a) {
      if (!equals(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) < accuracy;
}
function lessOrEquals(a, b, accuracy = EPSILON) {
  return a - b <= accuracy;
}
var Lab = class _Lab {
  l;
  a;
  b;
  alpha;
  #authoredText;
  #rawParams;
  channels = ["l" /* L */, "a" /* A */, "b" /* B */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(self.l, self.a, self.b), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => self,
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    return ColorConverter.labToXyzd50(this.l, this.a, this.b);
  }
  #getRGBArray(withAlpha = true) {
    const params = ColorConverter.xyzd50ToSrgb(...this.#toXyzd50());
    if (withAlpha) {
      return [...params, this.alpha ?? void 0];
    }
    return params;
  }
  constructor(l, a, b, alpha, authoredText) {
    this.#rawParams = [l, a, b];
    this.l = clamp(l, { min: 0, max: 100 });
    if (equals(this.l, 0, WIDE_RANGE_EPSILON) || equals(this.l, 100, WIDE_RANGE_EPSILON)) {
      a = b = 0;
    }
    this.a = a;
    this.b = b;
    this.alpha = clamp(alpha, { min: 0, max: 1 });
    this.#authoredText = authoredText;
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    return _Lab.#conversions[format](this);
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  equal(color) {
    const lab = color.as("lab" /* LAB */);
    return equals(lab.l, this.l, WIDE_RANGE_EPSILON) && equals(lab.a, this.a) && equals(lab.b, this.b) && equals(lab.alpha, this.alpha);
  }
  format() {
    return "lab" /* LAB */;
  }
  setAlpha(alpha) {
    return new _Lab(this.l, this.a, this.b, alpha, void 0);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.l, this.a, this.b);
  }
  #stringify(l, a, b) {
    const alpha = this.alpha === null || equals(this.alpha, 1) ? "" : ` / ${StringUtilities_exports.stringifyWithPrecision(this.alpha)}`;
    return `lab(${StringUtilities_exports.stringifyWithPrecision(l, 0)} ${StringUtilities_exports.stringifyWithPrecision(
      a
    )} ${StringUtilities_exports.stringifyWithPrecision(b)}${alpha})`;
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return false;
  }
  static fromSpec(spec, text) {
    const L = parsePercentage(spec[0], [0, 100]) ?? parseNumber(spec[0]);
    if (L === null) {
      return null;
    }
    const a = parsePercentage(spec[1], [0, 125]) ?? parseNumber(spec[1]);
    if (a === null) {
      return null;
    }
    const b = parsePercentage(spec[2], [0, 125]) ?? parseNumber(spec[2]);
    if (b === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _Lab(L, a, b, alpha, text);
  }
};
var LCH = class _LCH {
  #rawParams;
  l;
  c;
  h;
  alpha;
  #authoredText;
  channels = ["l" /* L */, "c" /* C */, "h" /* H */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => self,
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.lchToLab(self.l, self.c, self.h), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    return ColorConverter.labToXyzd50(...ColorConverter.lchToLab(this.l, this.c, this.h));
  }
  #getRGBArray(withAlpha = true) {
    const params = ColorConverter.xyzd50ToSrgb(...this.#toXyzd50());
    if (withAlpha) {
      return [...params, this.alpha ?? void 0];
    }
    return params;
  }
  constructor(l, c, h, alpha, authoredText) {
    this.#rawParams = [l, c, h];
    this.l = clamp(l, { min: 0, max: 100 });
    c = equals(this.l, 0, WIDE_RANGE_EPSILON) || equals(this.l, 100, WIDE_RANGE_EPSILON) ? 0 : c;
    this.c = clamp(c, { min: 0 });
    h = equals(c, 0) ? 0 : h;
    this.h = normalizeHue(h);
    this.alpha = clamp(alpha, { min: 0, max: 1 });
    this.#authoredText = authoredText;
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    return _LCH.#conversions[format](this);
  }
  equal(color) {
    const lch = color.as("lch" /* LCH */);
    return equals(lch.l, this.l, WIDE_RANGE_EPSILON) && equals(lch.c, this.c) && equals(lch.h, this.h) && equals(lch.alpha, this.alpha);
  }
  format() {
    return "lch" /* LCH */;
  }
  setAlpha(alpha) {
    return new _LCH(this.l, this.c, this.h, alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.l, this.c, this.h);
  }
  #stringify(l, c, h) {
    const alpha = this.alpha === null || equals(this.alpha, 1) ? "" : ` / ${StringUtilities_exports.stringifyWithPrecision(this.alpha)}`;
    return `lch(${StringUtilities_exports.stringifyWithPrecision(l, 0)} ${StringUtilities_exports.stringifyWithPrecision(
      c
    )} ${StringUtilities_exports.stringifyWithPrecision(h)}${alpha})`;
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return false;
  }
  // See "powerless" component definitions in
  // https://www.w3.org/TR/css-color-4/#specifying-lab-lch
  isHuePowerless() {
    return equals(this.c, 0, STRICT_EPSILON);
  }
  static fromSpec(spec, text) {
    const L = parsePercentage(spec[0], [0, 100]) ?? parseNumber(spec[0]);
    if (L === null) {
      return null;
    }
    const c = parsePercentage(spec[1], [0, 150]) ?? parseNumber(spec[1]);
    if (c === null) {
      return null;
    }
    const h = parseAngle(spec[2]);
    if (h === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _LCH(L, c, h, alpha, text);
  }
};
var Oklab = class _Oklab {
  #rawParams;
  l;
  a;
  b;
  alpha;
  #authoredText;
  channels = ["l" /* L */, "a" /* A */, "b" /* B */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => self,
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    return ColorConverter.xyzd65ToD50(...ColorConverter.oklabToXyzd65(this.l, this.a, this.b));
  }
  #getRGBArray(withAlpha = true) {
    const params = ColorConverter.xyzd50ToSrgb(...this.#toXyzd50());
    if (withAlpha) {
      return [...params, this.alpha ?? void 0];
    }
    return params;
  }
  constructor(l, a, b, alpha, authoredText) {
    this.#rawParams = [l, a, b];
    this.l = clamp(l, { min: 0, max: 1 });
    if (equals(this.l, 0) || equals(this.l, 1)) {
      a = b = 0;
    }
    this.a = a;
    this.b = b;
    this.alpha = clamp(alpha, { min: 0, max: 1 });
    this.#authoredText = authoredText;
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    return _Oklab.#conversions[format](this);
  }
  equal(color) {
    const oklab = color.as("oklab" /* OKLAB */);
    return equals(oklab.l, this.l) && equals(oklab.a, this.a) && equals(oklab.b, this.b) && equals(oklab.alpha, this.alpha);
  }
  format() {
    return "oklab" /* OKLAB */;
  }
  setAlpha(alpha) {
    return new _Oklab(this.l, this.a, this.b, alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.l, this.a, this.b);
  }
  #stringify(l, a, b) {
    const alpha = this.alpha === null || equals(this.alpha, 1) ? "" : ` / ${StringUtilities_exports.stringifyWithPrecision(this.alpha)}`;
    return `oklab(${StringUtilities_exports.stringifyWithPrecision(l)} ${StringUtilities_exports.stringifyWithPrecision(
      a
    )} ${StringUtilities_exports.stringifyWithPrecision(b)}${alpha})`;
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return false;
  }
  static fromSpec(spec, text) {
    const L = parsePercentage(spec[0], [0, 1]) ?? parseNumber(spec[0]);
    if (L === null) {
      return null;
    }
    const a = parsePercentage(spec[1], [0, 0.4]) ?? parseNumber(spec[1]);
    if (a === null) {
      return null;
    }
    const b = parsePercentage(spec[2], [0, 0.4]) ?? parseNumber(spec[2]);
    if (b === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _Oklab(L, a, b, alpha, text);
  }
};
var Oklch = class _Oklch {
  #rawParams;
  l;
  c;
  h;
  alpha;
  #authoredText;
  channels = ["l" /* L */, "c" /* C */, "h" /* H */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => self,
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    return ColorConverter.oklchToXyzd50(this.l, this.c, this.h);
  }
  #getRGBArray(withAlpha = true) {
    const params = ColorConverter.xyzd50ToSrgb(...this.#toXyzd50());
    if (withAlpha) {
      return [...params, this.alpha ?? void 0];
    }
    return params;
  }
  constructor(l, c, h, alpha, authoredText) {
    this.#rawParams = [l, c, h];
    this.l = clamp(l, { min: 0, max: 1 });
    c = equals(this.l, 0) || equals(this.l, 1) ? 0 : c;
    this.c = clamp(c, { min: 0 });
    h = equals(c, 0) ? 0 : h;
    this.h = normalizeHue(h);
    this.alpha = clamp(alpha, { min: 0, max: 1 });
    this.#authoredText = authoredText;
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    return _Oklch.#conversions[format](this);
  }
  equal(color) {
    const oklch = color.as("oklch" /* OKLCH */);
    return equals(oklch.l, this.l) && equals(oklch.c, this.c) && equals(oklch.h, this.h) && equals(oklch.alpha, this.alpha);
  }
  format() {
    return "oklch" /* OKLCH */;
  }
  setAlpha(alpha) {
    return new _Oklch(this.l, this.c, this.h, alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.l, this.c, this.h);
  }
  #stringify(l, c, h) {
    const alpha = this.alpha === null || equals(this.alpha, 1) ? "" : ` / ${StringUtilities_exports.stringifyWithPrecision(this.alpha)}`;
    return `oklch(${StringUtilities_exports.stringifyWithPrecision(l)} ${StringUtilities_exports.stringifyWithPrecision(
      c
    )} ${StringUtilities_exports.stringifyWithPrecision(h)}${alpha})`;
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return false;
  }
  static fromSpec(spec, text) {
    const L = parsePercentage(spec[0], [0, 1]) ?? parseNumber(spec[0]);
    if (L === null) {
      return null;
    }
    const c = parsePercentage(spec[1], [0, 0.4]) ?? parseNumber(spec[1]);
    if (c === null) {
      return null;
    }
    const h = parseAngle(spec[2]);
    if (h === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _Oklch(L, c, h, alpha, text);
  }
};
var ColorFunction = class _ColorFunction {
  #rawParams;
  p0;
  p1;
  p2;
  alpha;
  colorSpace;
  #authoredText;
  get channels() {
    return this.isXYZ() ? ["x" /* X */, "y" /* Y */, "z" /* Z */, "alpha" /* ALPHA */] : ["r" /* R */, "g" /* G */, "b" /* B */, "alpha" /* ALPHA */];
  }
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new _ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new _ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new _ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new _ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new _ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new _ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new _ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new _ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new _ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new _ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    const [p0, p1, p2] = this.#rawParams;
    switch (this.colorSpace) {
      case "srgb" /* SRGB */:
        return ColorConverter.srgbToXyzd50(p0, p1, p2);
      case "srgb-linear" /* SRGB_LINEAR */:
        return ColorConverter.srgbLinearToXyzd50(p0, p1, p2);
      case "display-p3" /* DISPLAY_P3 */:
        return ColorConverter.displayP3ToXyzd50(p0, p1, p2);
      case "display-p3-linear" /* DISPLAY_P3_LINEAR */:
        return ColorConverter.displayP3LinearToXyzd50(p0, p1, p2);
      case "a98-rgb" /* A98_RGB */:
        return ColorConverter.adobeRGBToXyzd50(p0, p1, p2);
      case "prophoto-rgb" /* PROPHOTO_RGB */:
        return ColorConverter.proPhotoToXyzd50(p0, p1, p2);
      case "rec2020" /* REC_2020 */:
        return ColorConverter.rec2020ToXyzd50(p0, p1, p2);
      case "xyz-d50" /* XYZ_D50 */:
        return [p0, p1, p2];
      case "xyz" /* XYZ */:
      case "xyz-d65" /* XYZ_D65 */:
        return ColorConverter.xyzd65ToD50(p0, p1, p2);
    }
    throw new Error("Invalid color space");
  }
  #getRGBArray(withAlpha = true) {
    const [p0, p1, p2] = this.#rawParams;
    const params = this.colorSpace === "srgb" /* SRGB */ ? [p0, p1, p2] : [...ColorConverter.xyzd50ToSrgb(...this.#toXyzd50())];
    if (withAlpha) {
      return [...params, this.alpha ?? void 0];
    }
    return params;
  }
  constructor(colorSpace, p0, p1, p2, alpha, authoredText) {
    this.#rawParams = [p0, p1, p2];
    this.colorSpace = colorSpace;
    this.#authoredText = authoredText;
    if (this.colorSpace !== "xyz-d50" /* XYZ_D50 */ && this.colorSpace !== "xyz-d65" /* XYZ_D65 */ && this.colorSpace !== "xyz" /* XYZ */) {
      p0 = clamp(p0, { min: 0, max: 1 });
      p1 = clamp(p1, { min: 0, max: 1 });
      p2 = clamp(p2, { min: 0, max: 1 });
    }
    this.p0 = p0;
    this.p1 = p1;
    this.p2 = p2;
    this.alpha = clamp(alpha, { min: 0, max: 1 });
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    if (this.colorSpace === format) {
      return this;
    }
    return _ColorFunction.#conversions[format](this);
  }
  equal(color) {
    const space = color.as(this.colorSpace);
    return equals(this.p0, space.p0) && equals(this.p1, space.p1) && equals(this.p2, space.p2) && equals(this.alpha, space.alpha);
  }
  format() {
    return this.colorSpace;
  }
  setAlpha(alpha) {
    return new _ColorFunction(this.colorSpace, this.p0, this.p1, this.p2, alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.p0, this.p1, this.p2);
  }
  #stringify(p0, p1, p2) {
    const alpha = this.alpha === null || equals(this.alpha, 1) ? "" : ` / ${StringUtilities_exports.stringifyWithPrecision(this.alpha)}`;
    return `color(${this.colorSpace} ${StringUtilities_exports.stringifyWithPrecision(p0)} ${StringUtilities_exports.stringifyWithPrecision(
      p1
    )} ${StringUtilities_exports.stringifyWithPrecision(p2)}${alpha})`;
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    if (this.colorSpace !== "xyz-d50" /* XYZ_D50 */ && this.colorSpace !== "xyz-d65" /* XYZ_D65 */ && this.colorSpace !== "xyz" /* XYZ */) {
      return !equals(this.#rawParams, [this.p0, this.p1, this.p2]);
    }
    return false;
  }
  isXYZ() {
    switch (this.colorSpace) {
      case "xyz" /* XYZ */:
      case "xyz-d50" /* XYZ_D50 */:
      case "xyz-d65" /* XYZ_D65 */:
        return true;
    }
    return false;
  }
  /**
   * Parses given `color()` function definition and returns the `Color` object.
   * We want to special case its parsing here because it's a bit different
   * than other color functions: rgb, lch etc. accepts 3 arguments with
   * optional alpha. This accepts 4 arguments with optional alpha.
   *
   * Instead of making `splitColorFunctionParameters` work for this case too
   * I've decided to implement it specifically.
   * @param authoredText Original definition of the color with `color`
   * @param parametersText Inside of the `color()` function. ex, `display-p3 0.1 0.2 0.3 / 0%`
   * @returns `Color` object
   */
  static fromSpec(authoredText, parametersWithAlphaText) {
    const [parametersText, alphaText] = parametersWithAlphaText.split("/", 2);
    const parameters = parametersText.trim().split(/\s+/);
    const [colorSpaceText, ...remainingParams] = parameters;
    const colorSpace = getColorSpace(colorSpaceText);
    if (!colorSpace) {
      return null;
    }
    if (remainingParams.length === 0 && alphaText === void 0) {
      return new _ColorFunction(colorSpace, 0, 0, 0, null, authoredText);
    }
    if (remainingParams.length === 0 && alphaText !== void 0 && alphaText.trim().split(/\s+/).length > 1) {
      return null;
    }
    if (remainingParams.length > 3) {
      return null;
    }
    const nonesReplacedParams = remainingParams.map((param) => param === "none" ? "0" : param);
    const values = nonesReplacedParams.map((param) => parsePercentOrNumber(param, [0, 1]));
    const containsNull = values.includes(null);
    if (containsNull) {
      return null;
    }
    const alphaValue = alphaText ? parsePercentOrNumber(alphaText, [0, 1]) ?? 1 : 1;
    const rgbOrXyza = [
      values[0] ?? 0,
      values[1] ?? 0,
      values[2] ?? 0,
      alphaValue
    ];
    return new _ColorFunction(colorSpace, ...rgbOrXyza, authoredText);
  }
};
var HSL = class _HSL {
  h;
  s;
  l;
  alpha;
  #rawParams;
  #authoredText;
  channels = ["h" /* H */, "s" /* S */, "l" /* L */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => self,
    ["hsla" /* HSLA */]: (self) => self,
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #getRGBArray(withAlpha = true) {
    const rgb = hsl2rgb([this.h, this.s, this.l, 0]);
    if (withAlpha) {
      return [rgb[0], rgb[1], rgb[2], this.alpha ?? void 0];
    }
    return [rgb[0], rgb[1], rgb[2]];
  }
  #toXyzd50() {
    const rgb = this.#getRGBArray(false);
    return ColorConverter.srgbToXyzd50(rgb[0], rgb[1], rgb[2]);
  }
  constructor(h, s, l, alpha, authoredText) {
    this.#rawParams = [h, s, l];
    this.l = clamp(l, { min: 0, max: 1 });
    s = equals(this.l, 0) || equals(this.l, 1) ? 0 : s;
    this.s = clamp(s, { min: 0, max: 1 });
    h = equals(this.s, 0, STRICT_EPSILON) ? 0 : h;
    this.h = normalizeHue(h * 360) / 360;
    this.alpha = clamp(alpha ?? null, { min: 0, max: 1 });
    this.#authoredText = authoredText;
  }
  equal(color) {
    const hsl = color.as("hsl" /* HSL */);
    return equals(this.h, hsl.h) && equals(this.s, hsl.s) && equals(this.l, hsl.l) && equals(this.alpha, hsl.alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.h, this.s, this.l);
  }
  #stringify(h, s, l) {
    const start = StringUtilities_exports.sprintf(
      "hsl(%sdeg %s% %s%",
      StringUtilities_exports.stringifyWithPrecision(h * 360),
      StringUtilities_exports.stringifyWithPrecision(s * 100),
      StringUtilities_exports.stringifyWithPrecision(l * 100)
    );
    if (this.alpha !== null && this.alpha !== 1) {
      return start + StringUtilities_exports.sprintf(
        " / %s%)",
        StringUtilities_exports.stringifyWithPrecision(this.alpha * 100)
      );
    }
    return start + ")";
  }
  setAlpha(alpha) {
    return new _HSL(this.h, this.s, this.l, alpha);
  }
  format() {
    return this.alpha === null || this.alpha === 1 ? "hsl" /* HSL */ : "hsla" /* HSLA */;
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    if (format === this.format()) {
      return this;
    }
    return _HSL.#conversions[format](this);
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return !lessOrEquals(this.#rawParams[1], 1) || !lessOrEquals(0, this.#rawParams[1]);
  }
  static fromSpec(spec, text) {
    const h = parseHueNumeric(spec[0]);
    if (h === null) {
      return null;
    }
    const s = parseSatLightNumeric(spec[1]);
    if (s === null) {
      return null;
    }
    const l = parseSatLightNumeric(spec[2]);
    if (l === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _HSL(h, s, l, alpha, text);
  }
  hsva() {
    const s = this.s * (this.l < 0.5 ? this.l : 1 - this.l);
    return [this.h, s !== 0 ? 2 * s / (this.l + s) : 0, this.l + s, this.alpha ?? 1];
  }
  canonicalHSLA() {
    return [Math.round(this.h * 360), Math.round(this.s * 100), Math.round(this.l * 100), this.alpha ?? 1];
  }
};
var HWB = class _HWB {
  h;
  w;
  b;
  alpha;
  #rawParams;
  #authoredText;
  channels = ["h" /* H */, "w" /* W */, "b" /* B */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      false
    ), "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new Legacy(self.#getRGBArray(
      /* withAlpha= */
      true
    ), "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl(self.#getRGBArray(
      /* withAlpha= */
      false
    )), self.alpha),
    ["hwb" /* HWB */]: (self) => self,
    ["hwba" /* HWBA */]: (self) => self,
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #getRGBArray(withAlpha = true) {
    const rgb = hwb2rgb([this.h, this.w, this.b, 0]);
    if (withAlpha) {
      return [rgb[0], rgb[1], rgb[2], this.alpha ?? void 0];
    }
    return [rgb[0], rgb[1], rgb[2]];
  }
  #toXyzd50() {
    const rgb = this.#getRGBArray(false);
    return ColorConverter.srgbToXyzd50(rgb[0], rgb[1], rgb[2]);
  }
  constructor(h, w, b, alpha, authoredText) {
    this.#rawParams = [h, w, b];
    this.w = clamp(w, { min: 0, max: 1 });
    this.b = clamp(b, { min: 0, max: 1 });
    h = lessOrEquals(1, this.w + this.b) ? 0 : h;
    this.h = normalizeHue(h * 360) / 360;
    this.alpha = clamp(alpha, { min: 0, max: 1 });
    if (lessOrEquals(1, this.w + this.b)) {
      const ratio = this.w / this.b;
      this.b = 1 / (1 + ratio);
      this.w = 1 - this.b;
    }
    this.#authoredText = authoredText;
  }
  equal(color) {
    const hwb = color.as("hwb" /* HWB */);
    return equals(this.h, hwb.h) && equals(this.w, hwb.w) && equals(this.b, hwb.b) && equals(this.alpha, hwb.alpha);
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(this.h, this.w, this.b);
  }
  #stringify(h, w, b) {
    const start = StringUtilities_exports.sprintf(
      "hwb(%sdeg %s% %s%",
      StringUtilities_exports.stringifyWithPrecision(h * 360),
      StringUtilities_exports.stringifyWithPrecision(w * 100),
      StringUtilities_exports.stringifyWithPrecision(b * 100)
    );
    if (this.alpha !== null && this.alpha !== 1) {
      return start + StringUtilities_exports.sprintf(
        " / %s%)",
        StringUtilities_exports.stringifyWithPrecision(this.alpha * 100)
      );
    }
    return start + ")";
  }
  setAlpha(alpha) {
    return new _HWB(this.h, this.w, this.b, alpha, this.#authoredText);
  }
  format() {
    return this.alpha !== null && !equals(this.alpha, 1) ? "hwba" /* HWBA */ : "hwb" /* HWB */;
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    if (format === this.format()) {
      return this;
    }
    return _HWB.#conversions[format](this);
  }
  asLegacyColor() {
    return this.as("rgba" /* RGBA */);
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  canonicalHWBA() {
    return [
      Math.round(this.h * 360),
      Math.round(this.w * 100),
      Math.round(this.b * 100),
      this.alpha ?? 1
    ];
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(...this.#rawParams);
  }
  isGamutClipped() {
    return !lessOrEquals(this.#rawParams[1], 1) || !lessOrEquals(0, this.#rawParams[1]) || !lessOrEquals(this.#rawParams[2], 1) || !lessOrEquals(0, this.#rawParams[2]);
  }
  static fromSpec(spec, text) {
    const h = parseHueNumeric(spec[0]);
    if (h === null) {
      return null;
    }
    const w = parseSatLightNumeric(spec[1]);
    if (w === null) {
      return null;
    }
    const b = parseSatLightNumeric(spec[2]);
    if (b === null) {
      return null;
    }
    const alpha = parseAlpha(spec[3]);
    return new _HWB(h, w, b, alpha, text);
  }
};
function toRgbValue(value) {
  return Math.round(value * 255);
}
var ShortFormatColorBase = class {
  color;
  channels = ["r" /* R */, "g" /* G */, "b" /* B */, "alpha" /* ALPHA */];
  constructor(color) {
    this.color = color;
  }
  get alpha() {
    return this.color.alpha;
  }
  rgba() {
    return this.color.rgba();
  }
  equal(color) {
    return this.color.equal(color);
  }
  setAlpha(alpha) {
    return this.color.setAlpha(alpha);
  }
  format() {
    return (this.alpha ?? 1) !== 1 ? "hexa" /* HEXA */ : "hex" /* HEX */;
  }
  as(format) {
    return this.color.as(format);
  }
  is(format) {
    return this.color.is(format);
  }
  asLegacyColor() {
    return this.color.asLegacyColor();
  }
  getAuthoredText() {
    return this.color.getAuthoredText();
  }
  getRawParameters() {
    return this.color.getRawParameters();
  }
  isGamutClipped() {
    return this.color.isGamutClipped();
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    const [r, g, b] = this.color.rgba();
    return this.stringify(r, g, b);
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    const [r, g, b] = this.getRawParameters();
    return this.stringify(r, g, b);
  }
};
var ShortHex = class _ShortHex extends ShortFormatColorBase {
  setAlpha(alpha) {
    return new _ShortHex(this.color.setAlpha(alpha));
  }
  asString(format) {
    return format && format !== this.format() ? super.as(format).asString() : super.asString();
  }
  stringify(r, g, b) {
    function toShortHexValue(value) {
      return (Math.round(value * 255) / 17).toString(16);
    }
    if (this.color.hasAlpha()) {
      return StringUtilities_exports.sprintf(
        "#%s%s%s%s",
        toShortHexValue(r),
        toShortHexValue(g),
        toShortHexValue(b),
        toShortHexValue(this.alpha ?? 1)
      ).toLowerCase();
    }
    return StringUtilities_exports.sprintf("#%s%s%s", toShortHexValue(r), toShortHexValue(g), toShortHexValue(b)).toLowerCase();
  }
};
var Nickname = class _Nickname extends ShortFormatColorBase {
  nickname;
  constructor(nickname, color) {
    super(color);
    this.nickname = nickname;
  }
  static fromName(name, text) {
    const nickname = name.toLowerCase();
    const rgba = Nicknames.get(nickname);
    if (rgba !== void 0) {
      return new _Nickname(nickname, Legacy.fromRGBA(rgba, text));
    }
    return null;
  }
  stringify() {
    return this.nickname;
  }
  getAsRawString(format) {
    return this.color.getAsRawString(format);
  }
};
var Legacy = class _Legacy {
  #rawParams;
  #rgba;
  #authoredText;
  #format;
  channels = ["r" /* R */, "g" /* G */, "b" /* B */, "alpha" /* ALPHA */];
  static #conversions = {
    ["hex" /* HEX */]: (self) => new _Legacy(self.#rgba, "hex" /* HEX */),
    ["hexa" /* HEXA */]: (self) => new _Legacy(self.#rgba, "hexa" /* HEXA */),
    ["rgb" /* RGB */]: (self) => new _Legacy(self.#rgba, "rgb" /* RGB */),
    ["rgba" /* RGBA */]: (self) => new _Legacy(self.#rgba, "rgba" /* RGBA */),
    ["hsl" /* HSL */]: (self) => new HSL(...rgbToHsl([self.#rgba[0], self.#rgba[1], self.#rgba[2]]), self.alpha),
    ["hsla" /* HSLA */]: (self) => new HSL(...rgbToHsl([self.#rgba[0], self.#rgba[1], self.#rgba[2]]), self.alpha),
    ["hwb" /* HWB */]: (self) => new HWB(...rgbToHwb([self.#rgba[0], self.#rgba[1], self.#rgba[2]]), self.alpha),
    ["hwba" /* HWBA */]: (self) => new HWB(...rgbToHwb([self.#rgba[0], self.#rgba[1], self.#rgba[2]]), self.alpha),
    ["lch" /* LCH */]: (self) => new LCH(...ColorConverter.labToLch(...ColorConverter.xyzd50ToLab(...self.#toXyzd50())), self.alpha),
    ["oklch" /* OKLCH */]: (self) => new Oklch(...ColorConverter.xyzd50ToOklch(...self.#toXyzd50()), self.alpha),
    ["lab" /* LAB */]: (self) => new Lab(...ColorConverter.xyzd50ToLab(...self.#toXyzd50()), self.alpha),
    ["oklab" /* OKLAB */]: (self) => new Oklab(...ColorConverter.xyzd65ToOklab(...ColorConverter.xyzd50ToD65(...self.#toXyzd50())), self.alpha),
    ["srgb" /* SRGB */]: (self) => new ColorFunction("srgb" /* SRGB */, ...ColorConverter.xyzd50ToSrgb(...self.#toXyzd50()), self.alpha),
    ["srgb-linear" /* SRGB_LINEAR */]: (self) => new ColorFunction("srgb-linear" /* SRGB_LINEAR */, ...ColorConverter.xyzd50TosRGBLinear(...self.#toXyzd50()), self.alpha),
    ["display-p3" /* DISPLAY_P3 */]: (self) => new ColorFunction("display-p3" /* DISPLAY_P3 */, ...ColorConverter.xyzd50ToDisplayP3(...self.#toXyzd50()), self.alpha),
    ["display-p3-linear" /* DISPLAY_P3_LINEAR */]: (self) => new ColorFunction(
      "display-p3-linear" /* DISPLAY_P3_LINEAR */,
      ...ColorConverter.xyzd50ToDisplayP3Linear(...self.#toXyzd50()),
      self.alpha
    ),
    ["a98-rgb" /* A98_RGB */]: (self) => new ColorFunction("a98-rgb" /* A98_RGB */, ...ColorConverter.xyzd50ToAdobeRGB(...self.#toXyzd50()), self.alpha),
    ["prophoto-rgb" /* PROPHOTO_RGB */]: (self) => new ColorFunction("prophoto-rgb" /* PROPHOTO_RGB */, ...ColorConverter.xyzd50ToProPhoto(...self.#toXyzd50()), self.alpha),
    ["rec2020" /* REC_2020 */]: (self) => new ColorFunction("rec2020" /* REC_2020 */, ...ColorConverter.xyzd50ToRec2020(...self.#toXyzd50()), self.alpha),
    ["xyz" /* XYZ */]: (self) => new ColorFunction("xyz" /* XYZ */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha),
    ["xyz-d50" /* XYZ_D50 */]: (self) => new ColorFunction("xyz-d50" /* XYZ_D50 */, ...self.#toXyzd50(), self.alpha),
    ["xyz-d65" /* XYZ_D65 */]: (self) => new ColorFunction("xyz-d65" /* XYZ_D65 */, ...ColorConverter.xyzd50ToD65(...self.#toXyzd50()), self.alpha)
  };
  #toXyzd50() {
    const [r, g, b] = this.#rgba;
    return ColorConverter.srgbToXyzd50(r, g, b);
  }
  get alpha() {
    switch (this.format()) {
      case "hexa" /* HEXA */:
      case "rgba" /* RGBA */:
        return this.#rgba[3];
      default:
        return null;
    }
  }
  asLegacyColor() {
    return this;
  }
  nickname() {
    const nickname = RGBAToNickname.get(String(this.canonicalRGBA()));
    return nickname ? new Nickname(nickname, this) : null;
  }
  shortHex() {
    for (let i = 0; i < 4; ++i) {
      const c = Math.round(this.#rgba[i] * 255);
      if (c % 17) {
        return null;
      }
    }
    return new ShortHex(this);
  }
  constructor(rgba, format, authoredText) {
    this.#authoredText = authoredText || null;
    this.#format = format;
    this.#rawParams = [rgba[0], rgba[1], rgba[2]];
    this.#rgba = [
      clamp(rgba[0], { min: 0, max: 1 }),
      clamp(rgba[1], { min: 0, max: 1 }),
      clamp(rgba[2], { min: 0, max: 1 }),
      clamp(rgba[3] ?? 1, { min: 0, max: 1 })
    ];
  }
  static fromHex(hex, text) {
    hex = hex.toLowerCase();
    const hasAlpha = hex.length === 4 || hex.length === 8;
    const format = hasAlpha ? "hexa" /* HEXA */ : "hex" /* HEX */;
    const isShort = hex.length <= 4;
    if (isShort) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3);
    }
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    let a = 1;
    if (hex.length === 8) {
      a = parseInt(hex.substring(6, 8), 16) / 255;
    }
    const color = new _Legacy([r / 255, g / 255, b / 255, a], format, text);
    return isShort ? new ShortHex(color) : color;
  }
  static fromRGBAFunction(r, g, b, alpha, text) {
    const rgba = [
      parseRgbNumeric(r),
      parseRgbNumeric(g),
      parseRgbNumeric(b),
      alpha ? parseAlphaNumeric(alpha) : 1
    ];
    if (!ArrayUtilities_exports.arrayDoesNotContainNullOrUndefined(rgba)) {
      return null;
    }
    return new _Legacy(rgba, alpha ? "rgba" /* RGBA */ : "rgb" /* RGB */, text);
  }
  static fromRGBA(rgba, authoredText) {
    return new _Legacy([rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3]], "rgba" /* RGBA */, authoredText);
  }
  static fromHSVA(hsva) {
    const rgba = hsva2rgba(hsva);
    return new _Legacy(rgba, "rgba" /* RGBA */);
  }
  is(format) {
    return format === this.format();
  }
  as(format) {
    if (format === this.format()) {
      return this;
    }
    return _Legacy.#conversions[format](this);
  }
  format() {
    return this.#format;
  }
  hasAlpha() {
    return this.#rgba[3] !== 1;
  }
  detectHEXFormat() {
    const hasAlpha = this.hasAlpha();
    return hasAlpha ? "hexa" /* HEXA */ : "hex" /* HEX */;
  }
  asString(format) {
    if (format) {
      return this.as(format).asString();
    }
    return this.#stringify(format, this.#rgba[0], this.#rgba[1], this.#rgba[2]);
  }
  #stringify(format, r, g, b) {
    if (!format) {
      format = this.#format;
    }
    function toHexValue(value) {
      const hex = Math.round(value * 255).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    }
    switch (format) {
      case "rgb" /* RGB */:
      case "rgba" /* RGBA */: {
        const start = StringUtilities_exports.sprintf("rgb(%d %d %d", toRgbValue(r), toRgbValue(g), toRgbValue(b));
        if (this.hasAlpha()) {
          return start + StringUtilities_exports.sprintf(" / %d%)", Math.round(this.#rgba[3] * 100));
        }
        return start + ")";
      }
      case "hex" /* HEX */:
      case "hexa" /* HEXA */: {
        if (this.hasAlpha()) {
          return StringUtilities_exports.sprintf("#%s%s%s%s", toHexValue(r), toHexValue(g), toHexValue(b), toHexValue(this.#rgba[3])).toLowerCase();
        }
        return StringUtilities_exports.sprintf("#%s%s%s", toHexValue(r), toHexValue(g), toHexValue(b)).toLowerCase();
      }
    }
  }
  getAuthoredText() {
    return this.#authoredText ?? null;
  }
  getRawParameters() {
    return [...this.#rawParams];
  }
  getAsRawString(format) {
    if (format) {
      return this.as(format).getAsRawString();
    }
    return this.#stringify(format, ...this.#rawParams);
  }
  isGamutClipped() {
    return !equals(
      this.#rawParams.map(toRgbValue),
      [this.#rgba[0], this.#rgba[1], this.#rgba[2]].map(toRgbValue),
      WIDE_RANGE_EPSILON
    );
  }
  rgba() {
    return [...this.#rgba];
  }
  canonicalRGBA() {
    const rgba = new Array(4);
    for (let i = 0; i < 3; ++i) {
      rgba[i] = Math.round(this.#rgba[i] * 255);
    }
    rgba[3] = this.#rgba[3];
    return rgba;
  }
  toProtocolRGBA() {
    const rgba = this.canonicalRGBA();
    const result = { r: rgba[0], g: rgba[1], b: rgba[2] };
    if (rgba[3] !== 1) {
      result.a = rgba[3];
    }
    return result;
  }
  invert() {
    const rgba = [0, 0, 0, 0];
    rgba[0] = 1 - this.#rgba[0];
    rgba[1] = 1 - this.#rgba[1];
    rgba[2] = 1 - this.#rgba[2];
    rgba[3] = this.#rgba[3];
    return new _Legacy(rgba, "rgba" /* RGBA */);
  }
  /**
   * Returns a new color using the NTSC formula for making a RGB color grayscale.
   * Note: We override with an alpha of 50% to enhance the dimming effect.
   */
  grayscale() {
    const [r, g, b] = this.#rgba;
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    return new _Legacy([gray, gray, gray, 0.5], "rgba" /* RGBA */);
  }
  setAlpha(alpha) {
    const rgba = [...this.#rgba];
    rgba[3] = alpha;
    return new _Legacy(rgba, "rgba" /* RGBA */);
  }
  blendWith(fgColor) {
    const rgba = blendColors(fgColor.#rgba, this.#rgba);
    return new _Legacy(rgba, "rgba" /* RGBA */);
  }
  blendWithAlpha(alpha) {
    const rgba = [...this.#rgba];
    rgba[3] *= alpha;
    return new _Legacy(rgba, "rgba" /* RGBA */);
  }
  setFormat(format) {
    this.#format = format;
  }
  equal(other) {
    const legacy = other.as(this.#format);
    return equals(toRgbValue(this.#rgba[0]), toRgbValue(legacy.#rgba[0]), WIDE_RANGE_EPSILON) && equals(toRgbValue(this.#rgba[1]), toRgbValue(legacy.#rgba[1]), WIDE_RANGE_EPSILON) && equals(toRgbValue(this.#rgba[2]), toRgbValue(legacy.#rgba[2]), WIDE_RANGE_EPSILON) && equals(this.#rgba[3], legacy.#rgba[3]);
  }
};
var COLOR_TO_RGBA_ENTRIES = [
  ["aliceblue", [240, 248, 255]],
  ["antiquewhite", [250, 235, 215]],
  ["aqua", [0, 255, 255]],
  ["aquamarine", [127, 255, 212]],
  ["azure", [240, 255, 255]],
  ["beige", [245, 245, 220]],
  ["bisque", [255, 228, 196]],
  ["black", [0, 0, 0]],
  ["blanchedalmond", [255, 235, 205]],
  ["blue", [0, 0, 255]],
  ["blueviolet", [138, 43, 226]],
  ["brown", [165, 42, 42]],
  ["burlywood", [222, 184, 135]],
  ["cadetblue", [95, 158, 160]],
  ["chartreuse", [127, 255, 0]],
  ["chocolate", [210, 105, 30]],
  ["coral", [255, 127, 80]],
  ["cornflowerblue", [100, 149, 237]],
  ["cornsilk", [255, 248, 220]],
  ["crimson", [237, 20, 61]],
  ["cyan", [0, 255, 255]],
  ["darkblue", [0, 0, 139]],
  ["darkcyan", [0, 139, 139]],
  ["darkgoldenrod", [184, 134, 11]],
  ["darkgray", [169, 169, 169]],
  ["darkgrey", [169, 169, 169]],
  ["darkgreen", [0, 100, 0]],
  ["darkkhaki", [189, 183, 107]],
  ["darkmagenta", [139, 0, 139]],
  ["darkolivegreen", [85, 107, 47]],
  ["darkorange", [255, 140, 0]],
  ["darkorchid", [153, 50, 204]],
  ["darkred", [139, 0, 0]],
  ["darksalmon", [233, 150, 122]],
  ["darkseagreen", [143, 188, 143]],
  ["darkslateblue", [72, 61, 139]],
  ["darkslategray", [47, 79, 79]],
  ["darkslategrey", [47, 79, 79]],
  ["darkturquoise", [0, 206, 209]],
  ["darkviolet", [148, 0, 211]],
  ["deeppink", [255, 20, 147]],
  ["deepskyblue", [0, 191, 255]],
  ["dimgray", [105, 105, 105]],
  ["dimgrey", [105, 105, 105]],
  ["dodgerblue", [30, 144, 255]],
  ["firebrick", [178, 34, 34]],
  ["floralwhite", [255, 250, 240]],
  ["forestgreen", [34, 139, 34]],
  ["fuchsia", [255, 0, 255]],
  ["gainsboro", [220, 220, 220]],
  ["ghostwhite", [248, 248, 255]],
  ["gold", [255, 215, 0]],
  ["goldenrod", [218, 165, 32]],
  ["gray", [128, 128, 128]],
  ["grey", [128, 128, 128]],
  ["green", [0, 128, 0]],
  ["greenyellow", [173, 255, 47]],
  ["honeydew", [240, 255, 240]],
  ["hotpink", [255, 105, 180]],
  ["indianred", [205, 92, 92]],
  ["indigo", [75, 0, 130]],
  ["ivory", [255, 255, 240]],
  ["khaki", [240, 230, 140]],
  ["lavender", [230, 230, 250]],
  ["lavenderblush", [255, 240, 245]],
  ["lawngreen", [124, 252, 0]],
  ["lemonchiffon", [255, 250, 205]],
  ["lightblue", [173, 216, 230]],
  ["lightcoral", [240, 128, 128]],
  ["lightcyan", [224, 255, 255]],
  ["lightgoldenrodyellow", [250, 250, 210]],
  ["lightgreen", [144, 238, 144]],
  ["lightgray", [211, 211, 211]],
  ["lightgrey", [211, 211, 211]],
  ["lightpink", [255, 182, 193]],
  ["lightsalmon", [255, 160, 122]],
  ["lightseagreen", [32, 178, 170]],
  ["lightskyblue", [135, 206, 250]],
  ["lightslategray", [119, 136, 153]],
  ["lightslategrey", [119, 136, 153]],
  ["lightsteelblue", [176, 196, 222]],
  ["lightyellow", [255, 255, 224]],
  ["lime", [0, 255, 0]],
  ["limegreen", [50, 205, 50]],
  ["linen", [250, 240, 230]],
  ["magenta", [255, 0, 255]],
  ["maroon", [128, 0, 0]],
  ["mediumaquamarine", [102, 205, 170]],
  ["mediumblue", [0, 0, 205]],
  ["mediumorchid", [186, 85, 211]],
  ["mediumpurple", [147, 112, 219]],
  ["mediumseagreen", [60, 179, 113]],
  ["mediumslateblue", [123, 104, 238]],
  ["mediumspringgreen", [0, 250, 154]],
  ["mediumturquoise", [72, 209, 204]],
  ["mediumvioletred", [199, 21, 133]],
  ["midnightblue", [25, 25, 112]],
  ["mintcream", [245, 255, 250]],
  ["mistyrose", [255, 228, 225]],
  ["moccasin", [255, 228, 181]],
  ["navajowhite", [255, 222, 173]],
  ["navy", [0, 0, 128]],
  ["oldlace", [253, 245, 230]],
  ["olive", [128, 128, 0]],
  ["olivedrab", [107, 142, 35]],
  ["orange", [255, 165, 0]],
  ["orangered", [255, 69, 0]],
  ["orchid", [218, 112, 214]],
  ["palegoldenrod", [238, 232, 170]],
  ["palegreen", [152, 251, 152]],
  ["paleturquoise", [175, 238, 238]],
  ["palevioletred", [219, 112, 147]],
  ["papayawhip", [255, 239, 213]],
  ["peachpuff", [255, 218, 185]],
  ["peru", [205, 133, 63]],
  ["pink", [255, 192, 203]],
  ["plum", [221, 160, 221]],
  ["powderblue", [176, 224, 230]],
  ["purple", [128, 0, 128]],
  ["rebeccapurple", [102, 51, 153]],
  ["red", [255, 0, 0]],
  ["rosybrown", [188, 143, 143]],
  ["royalblue", [65, 105, 225]],
  ["saddlebrown", [139, 69, 19]],
  ["salmon", [250, 128, 114]],
  ["sandybrown", [244, 164, 96]],
  ["seagreen", [46, 139, 87]],
  ["seashell", [255, 245, 238]],
  ["sienna", [160, 82, 45]],
  ["silver", [192, 192, 192]],
  ["skyblue", [135, 206, 235]],
  ["slateblue", [106, 90, 205]],
  ["slategray", [112, 128, 144]],
  ["slategrey", [112, 128, 144]],
  ["snow", [255, 250, 250]],
  ["springgreen", [0, 255, 127]],
  ["steelblue", [70, 130, 180]],
  ["tan", [210, 180, 140]],
  ["teal", [0, 128, 128]],
  ["thistle", [216, 191, 216]],
  ["tomato", [255, 99, 71]],
  ["turquoise", [64, 224, 208]],
  ["violet", [238, 130, 238]],
  ["wheat", [245, 222, 179]],
  ["white", [255, 255, 255]],
  ["whitesmoke", [245, 245, 245]],
  ["yellow", [255, 255, 0]],
  ["yellowgreen", [154, 205, 50]],
  ["transparent", [0, 0, 0, 0]]
];
console.assert(
  COLOR_TO_RGBA_ENTRIES.every(([nickname]) => nickname.toLowerCase() === nickname),
  "All color nicknames must be lowercase."
);
var Nicknames = new Map(COLOR_TO_RGBA_ENTRIES);
var RGBAToNickname = new Map(
  // Default opacity to 1 if the color only specified 3 channels
  COLOR_TO_RGBA_ENTRIES.map(([nickname, [r, g, b, a = 1]]) => {
    return [String([r, g, b, a]), nickname];
  })
);
var LAYOUT_LINES_HIGHLIGHT_COLOR = [127, 32, 210];
var PageHighlight = {
  Content: Legacy.fromRGBA([111, 168, 220, 0.66]),
  ContentLight: Legacy.fromRGBA([111, 168, 220, 0.5]),
  ContentOutline: Legacy.fromRGBA([9, 83, 148]),
  Padding: Legacy.fromRGBA([147, 196, 125, 0.55]),
  PaddingLight: Legacy.fromRGBA([147, 196, 125, 0.4]),
  Border: Legacy.fromRGBA([255, 229, 153, 0.66]),
  BorderLight: Legacy.fromRGBA([255, 229, 153, 0.5]),
  Margin: Legacy.fromRGBA([246, 178, 107, 0.66]),
  MarginLight: Legacy.fromRGBA([246, 178, 107, 0.5]),
  EventTarget: Legacy.fromRGBA([255, 196, 196, 0.66]),
  Shape: Legacy.fromRGBA([96, 82, 177, 0.8]),
  ShapeMargin: Legacy.fromRGBA([96, 82, 127, 0.6]),
  CssGrid: Legacy.fromRGBA([75, 0, 130, 1]),
  LayoutLine: Legacy.fromRGBA([...LAYOUT_LINES_HIGHLIGHT_COLOR, 1]),
  GridBorder: Legacy.fromRGBA([...LAYOUT_LINES_HIGHLIGHT_COLOR, 1]),
  GapBackground: Legacy.fromRGBA([...LAYOUT_LINES_HIGHLIGHT_COLOR, 0.3]),
  GapHatch: Legacy.fromRGBA([...LAYOUT_LINES_HIGHLIGHT_COLOR, 0.8]),
  GridAreaBorder: Legacy.fromRGBA([26, 115, 232, 1])
};
var SourceOrderHighlight = {
  ParentOutline: Legacy.fromRGBA([224, 90, 183, 1]),
  ChildOutline: Legacy.fromRGBA([0, 120, 212, 1])
};
var IsolationModeHighlight = {
  Resizer: Legacy.fromRGBA([222, 225, 230, 1]),
  // --color-background-elevation-2
  ResizerHandle: Legacy.fromRGBA([166, 166, 166, 1]),
  Mask: Legacy.fromRGBA([248, 249, 249, 1])
};

// upstream-mock:runtime
var runtime_exports = {};
__export(runtime_exports, {
  ExperimentName: () => ExperimentName,
  GdpProfilesEnterprisePolicyValue: () => GdpProfilesEnterprisePolicyValue,
  GenAiEnterprisePolicyValue: () => GenAiEnterprisePolicyValue,
  HostConfigFreestylerExecutionMode: () => HostConfigFreestylerExecutionMode,
  Runtime: () => Runtime,
  experiments: () => experiments,
  getChromeVersion: () => getChromeVersion,
  getRemoteBase: () => getRemoteBase,
  hostConfig: () => hostConfig
});
function getChromeVersion() {
  return "";
}
function getRemoteBase() {
  return null;
}
var hostConfig = {};
var GenAiEnterprisePolicyValue = {
  ALLOW: 0,
  ALLOW_WITHOUT_LOGGING: 1,
  DISABLE: 2
};
var HostConfigFreestylerExecutionMode = {
  ALL_SCRIPTS: "ALL_SCRIPTS",
  SIDE_EFFECT_FREE_SCRIPTS_ONLY: "SIDE_EFFECT_FREE_SCRIPTS_ONLY",
  NO_SCRIPTS: "NO_SCRIPTS"
};
var GdpProfilesEnterprisePolicyValue = {
  ENABLED: 0,
  ENABLED_WITHOUT_BADGES: 1,
  DISABLED: 2
};
var Runtime = {
  isDescriptorEnabled: () => true,
  queryParam: () => null
};
var experiments = {
  isEnabled: () => false
};
var ExperimentName = {
  ALL: "*",
  CAPTURE_NODE_CREATION_STACKS: "capture-node-creation-stacks",
  LIVE_HEAP_PROFILE: "live-heap-profile",
  PROTOCOL_MONITOR: "protocol-monitor",
  SAMPLING_HEAP_PROFILER_TIMELINE: "sampling-heap-profiler-timeline",
  SHOW_OPTION_TO_EXPOSE_INTERNALS_IN_HEAP_SNAPSHOT: "show-option-to-expose-internals-in-heap-snapshot",
  TIMELINE_INVALIDATION_TRACKING: "timeline-invalidation-tracking",
  TIMELINE_SHOW_ALL_EVENTS: "timeline-show-all-events",
  TIMELINE_V8_RUNTIME_CALL_STATS: "timeline-v8-runtime-call-stats",
  APCA: "apca",
  FONT_EDITOR: "font-editor",
  FULL_ACCESSIBILITY_TREE: "full-accessibility-tree",
  CONTRAST_ISSUES: "contrast-issues",
  EXPERIMENTAL_COOKIE_FEATURES: "experimental-cookie-features",
  INSTRUMENTATION_BREAKPOINTS: "instrumentation-breakpoints",
  AUTHORED_DEPLOYED_GROUPING: "authored-deployed-grouping",
  JUST_MY_CODE: "just-my-code",
  USE_SOURCE_MAP_SCOPES: "use-source-map-scopes",
  TIMELINE_SHOW_POST_MESSAGE_EVENTS: "timeline-show-postmessage-events",
  TIMELINE_DEBUG_MODE: "timeline-debug-mode"
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/DevToolsLocale.ts
var devToolsLocaleInstance = null;
var DevToolsLocale = class _DevToolsLocale {
  locale;
  lookupClosestDevToolsLocale;
  constructor(data) {
    this.lookupClosestDevToolsLocale = data.lookupClosestDevToolsLocale;
    if (data.settingLanguage === "browserLanguage") {
      this.locale = data.navigatorLanguage || "en-US";
    } else {
      this.locale = data.settingLanguage;
    }
    this.locale = this.lookupClosestDevToolsLocale(this.locale);
  }
  static instance(opts = { create: false }) {
    if (!devToolsLocaleInstance && !opts.create) {
      throw new Error("No LanguageSelector instance exists yet.");
    }
    if (opts.create) {
      devToolsLocaleInstance = new _DevToolsLocale(opts.data);
    }
    return devToolsLocaleInstance;
  }
  static removeInstance() {
    devToolsLocaleInstance = null;
  }
  forceFallbackLocale() {
    this.locale = "en-US";
  }
  /**
   * Returns true iff DevTools supports the language of the passed locale.
   * Note that it doesn't have to be a one-to-one match, e.g. if DevTools supports
   * 'de', then passing 'de-AT' will return true.
   */
  languageIsSupportedByDevTools(localeString) {
    return localeLanguagesMatch(localeString, this.lookupClosestDevToolsLocale(localeString));
  }
};
function localeLanguagesMatch(localeString1, localeString2) {
  const locale1 = new Intl.Locale(localeString1);
  const locale2 = new Intl.Locale(localeString2);
  return locale1.language === locale2.language;
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/NumberFormatter.ts
function defineFormatter(options) {
  let intlNumberFormat;
  return {
    format(value, separator) {
      if (!intlNumberFormat) {
        intlNumberFormat = new Intl.NumberFormat(DevToolsLocale.instance().locale, options);
      }
      return formatAndEnsureSpace(intlNumberFormat, value, separator);
    },
    formatToParts(value) {
      if (!intlNumberFormat) {
        intlNumberFormat = new Intl.NumberFormat(DevToolsLocale.instance().locale, options);
      }
      return intlNumberFormat.formatToParts(value);
    }
  };
}
function formatAndEnsureSpace(formatter, value, separator = "\xA0") {
  const parts = formatter.formatToParts(value);
  let hasSpace = false;
  for (const part of parts) {
    if (part.type === "literal") {
      if (part.value === " ") {
        hasSpace = true;
        part.value = separator;
      } else if (part.value === separator) {
        hasSpace = true;
      }
    }
  }
  if (hasSpace) {
    return parts.map((part) => part.value).join("");
  }
  const unitIndex = parts.findIndex((part) => part.type === "unit");
  if (unitIndex === -1) {
    return parts.map((part) => part.value).join("");
  }
  if (unitIndex === 0) {
    return parts[0].value + separator + parts.slice(1).map((part) => part.value).join("");
  }
  return parts.slice(0, unitIndex).map((part) => part.value).join("") + separator + parts.slice(unitIndex).map((part) => part.value).join("");
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/ByteUtilities.ts
var narrowBytes = defineFormatter({
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
var narrowKilobytesDecimal = defineFormatter({
  style: "unit",
  unit: "kilobyte",
  unitDisplay: "narrow",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
var narrowKilobytesInteger = defineFormatter({
  style: "unit",
  unit: "kilobyte",
  unitDisplay: "narrow",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
var narrowMegabytesDecimal = defineFormatter({
  style: "unit",
  unit: "megabyte",
  unitDisplay: "narrow",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
var narrowMegabytesInteger = defineFormatter({
  style: "unit",
  unit: "megabyte",
  unitDisplay: "narrow",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/i18nImpl.ts
var i18nImpl_exports = {};
__export(i18nImpl_exports, {
  deserializeUIString: () => deserializeUIString,
  fetchAndRegisterLocaleData: () => fetchAndRegisterLocaleData,
  getAllSupportedDevToolsLocales: () => getAllSupportedDevToolsLocales,
  getLazilyComputedLocalizedString: () => getLazilyComputedLocalizedString,
  getLocalizedLanguageRegion: () => getLocalizedLanguageRegion,
  getLocalizedString: () => getLocalizedString,
  hasLocaleDataForTest: () => hasLocaleDataForTest,
  lockedLazyString: () => lockedLazyString,
  lockedString: () => lockedString,
  lookupClosestSupportedDevToolsLocale: () => lookupClosestSupportedDevToolsLocale,
  registerLocaleDataForTest: () => registerLocaleDataForTest,
  registerUIStrings: () => registerUIStrings,
  resetLocaleDataForTest: () => resetLocaleDataForTest,
  serializeUIString: () => serializeUIString
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/i18n/i18n-impl.ts
var i18n_impl_exports = {};
__export(i18n_impl_exports, {
  I18n: () => I18n
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/intl-messageformat/package/intl-messageformat.esm.js
var __assign = function() {
  __assign = Object.assign || function __assign2(t) {
    for (var s, i = 1, n = arguments.length; i < n; i++) {
      s = arguments[i];
      for (var p in s)
        if (Object.prototype.hasOwnProperty.call(s, p))
          t[p] = s[p];
    }
    return t;
  };
  return __assign.apply(this, arguments);
};
var ErrorKind;
(function(ErrorKind2) {
  ErrorKind2[ErrorKind2["EXPECT_ARGUMENT_CLOSING_BRACE"] = 1] = "EXPECT_ARGUMENT_CLOSING_BRACE";
  ErrorKind2[ErrorKind2["EMPTY_ARGUMENT"] = 2] = "EMPTY_ARGUMENT";
  ErrorKind2[ErrorKind2["MALFORMED_ARGUMENT"] = 3] = "MALFORMED_ARGUMENT";
  ErrorKind2[ErrorKind2["EXPECT_ARGUMENT_TYPE"] = 4] = "EXPECT_ARGUMENT_TYPE";
  ErrorKind2[ErrorKind2["INVALID_ARGUMENT_TYPE"] = 5] = "INVALID_ARGUMENT_TYPE";
  ErrorKind2[ErrorKind2["EXPECT_ARGUMENT_STYLE"] = 6] = "EXPECT_ARGUMENT_STYLE";
  ErrorKind2[ErrorKind2["INVALID_NUMBER_SKELETON"] = 7] = "INVALID_NUMBER_SKELETON";
  ErrorKind2[ErrorKind2["INVALID_DATE_TIME_SKELETON"] = 8] = "INVALID_DATE_TIME_SKELETON";
  ErrorKind2[ErrorKind2["EXPECT_NUMBER_SKELETON"] = 9] = "EXPECT_NUMBER_SKELETON";
  ErrorKind2[ErrorKind2["EXPECT_DATE_TIME_SKELETON"] = 10] = "EXPECT_DATE_TIME_SKELETON";
  ErrorKind2[ErrorKind2["UNCLOSED_QUOTE_IN_ARGUMENT_STYLE"] = 11] = "UNCLOSED_QUOTE_IN_ARGUMENT_STYLE";
  ErrorKind2[ErrorKind2["EXPECT_SELECT_ARGUMENT_OPTIONS"] = 12] = "EXPECT_SELECT_ARGUMENT_OPTIONS";
  ErrorKind2[ErrorKind2["EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE"] = 13] = "EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE";
  ErrorKind2[ErrorKind2["INVALID_PLURAL_ARGUMENT_OFFSET_VALUE"] = 14] = "INVALID_PLURAL_ARGUMENT_OFFSET_VALUE";
  ErrorKind2[ErrorKind2["EXPECT_SELECT_ARGUMENT_SELECTOR"] = 15] = "EXPECT_SELECT_ARGUMENT_SELECTOR";
  ErrorKind2[ErrorKind2["EXPECT_PLURAL_ARGUMENT_SELECTOR"] = 16] = "EXPECT_PLURAL_ARGUMENT_SELECTOR";
  ErrorKind2[ErrorKind2["EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT"] = 17] = "EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT";
  ErrorKind2[ErrorKind2["EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT"] = 18] = "EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT";
  ErrorKind2[ErrorKind2["INVALID_PLURAL_ARGUMENT_SELECTOR"] = 19] = "INVALID_PLURAL_ARGUMENT_SELECTOR";
  ErrorKind2[ErrorKind2["DUPLICATE_PLURAL_ARGUMENT_SELECTOR"] = 20] = "DUPLICATE_PLURAL_ARGUMENT_SELECTOR";
  ErrorKind2[ErrorKind2["DUPLICATE_SELECT_ARGUMENT_SELECTOR"] = 21] = "DUPLICATE_SELECT_ARGUMENT_SELECTOR";
  ErrorKind2[ErrorKind2["MISSING_OTHER_CLAUSE"] = 22] = "MISSING_OTHER_CLAUSE";
  ErrorKind2[ErrorKind2["INVALID_TAG"] = 23] = "INVALID_TAG";
  ErrorKind2[ErrorKind2["INVALID_TAG_NAME"] = 25] = "INVALID_TAG_NAME";
  ErrorKind2[ErrorKind2["UNMATCHED_CLOSING_TAG"] = 26] = "UNMATCHED_CLOSING_TAG";
  ErrorKind2[ErrorKind2["UNCLOSED_TAG"] = 27] = "UNCLOSED_TAG";
})(ErrorKind || (ErrorKind = {}));
var TYPE;
(function(TYPE2) {
  TYPE2[TYPE2["literal"] = 0] = "literal";
  TYPE2[TYPE2["argument"] = 1] = "argument";
  TYPE2[TYPE2["number"] = 2] = "number";
  TYPE2[TYPE2["date"] = 3] = "date";
  TYPE2[TYPE2["time"] = 4] = "time";
  TYPE2[TYPE2["select"] = 5] = "select";
  TYPE2[TYPE2["plural"] = 6] = "plural";
  TYPE2[TYPE2["pound"] = 7] = "pound";
  TYPE2[TYPE2["tag"] = 8] = "tag";
})(TYPE || (TYPE = {}));
var SKELETON_TYPE;
(function(SKELETON_TYPE2) {
  SKELETON_TYPE2[SKELETON_TYPE2["number"] = 0] = "number";
  SKELETON_TYPE2[SKELETON_TYPE2["dateTime"] = 1] = "dateTime";
})(SKELETON_TYPE || (SKELETON_TYPE = {}));
function isLiteralElement(el) {
  return el.type === TYPE.literal;
}
function isArgumentElement(el) {
  return el.type === TYPE.argument;
}
function isNumberElement(el) {
  return el.type === TYPE.number;
}
function isDateElement(el) {
  return el.type === TYPE.date;
}
function isTimeElement(el) {
  return el.type === TYPE.time;
}
function isSelectElement(el) {
  return el.type === TYPE.select;
}
function isPluralElement(el) {
  return el.type === TYPE.plural;
}
function isPoundElement(el) {
  return el.type === TYPE.pound;
}
function isTagElement(el) {
  return el.type === TYPE.tag;
}
function isNumberSkeleton(el) {
  return !!(el && typeof el === "object" && el.type === SKELETON_TYPE.number);
}
function isDateTimeSkeleton(el) {
  return !!(el && typeof el === "object" && el.type === SKELETON_TYPE.dateTime);
}
var SPACE_SEPARATOR_REGEX = /[ \xA0\u1680\u2000-\u200A\u202F\u205F\u3000]/;
var DATE_TIME_REGEX = /(?:[Eec]{1,6}|G{1,5}|[Qq]{1,5}|(?:[yYur]+|U{1,5})|[ML]{1,5}|d{1,2}|D{1,3}|F{1}|[abB]{1,5}|[hkHK]{1,2}|w{1,2}|W{1}|m{1,2}|s{1,2}|[zZOvVxX]{1,4})(?=([^']*'[^']*')*[^']*$)/g;
function parseDateTimeSkeleton(skeleton) {
  var result = {};
  skeleton.replace(DATE_TIME_REGEX, function(match) {
    var len = match.length;
    switch (match[0]) {
      case "G":
        result.era = len === 4 ? "long" : len === 5 ? "narrow" : "short";
        break;
      case "y":
        result.year = len === 2 ? "2-digit" : "numeric";
        break;
      case "Y":
      case "u":
      case "U":
      case "r":
        throw new RangeError("`Y/u/U/r` (year) patterns are not supported, use `y` instead");
      case "q":
      case "Q":
        throw new RangeError("`q/Q` (quarter) patterns are not supported");
      case "M":
      case "L":
        result.month = ["numeric", "2-digit", "short", "long", "narrow"][len - 1];
        break;
      case "w":
      case "W":
        throw new RangeError("`w/W` (week) patterns are not supported");
      case "d":
        result.day = ["numeric", "2-digit"][len - 1];
        break;
      case "D":
      case "F":
      case "g":
        throw new RangeError("`D/F/g` (day) patterns are not supported, use `d` instead");
      case "E":
        result.weekday = len === 4 ? "short" : len === 5 ? "narrow" : "short";
        break;
      case "e":
        if (len < 4) {
          throw new RangeError("`e..eee` (weekday) patterns are not supported");
        }
        result.weekday = ["short", "long", "narrow", "short"][len - 4];
        break;
      case "c":
        if (len < 4) {
          throw new RangeError("`c..ccc` (weekday) patterns are not supported");
        }
        result.weekday = ["short", "long", "narrow", "short"][len - 4];
        break;
      case "a":
        result.hour12 = true;
        break;
      case "b":
      case "B":
        throw new RangeError("`b/B` (period) patterns are not supported, use `a` instead");
      case "h":
        result.hourCycle = "h12";
        result.hour = ["numeric", "2-digit"][len - 1];
        break;
      case "H":
        result.hourCycle = "h23";
        result.hour = ["numeric", "2-digit"][len - 1];
        break;
      case "K":
        result.hourCycle = "h11";
        result.hour = ["numeric", "2-digit"][len - 1];
        break;
      case "k":
        result.hourCycle = "h24";
        result.hour = ["numeric", "2-digit"][len - 1];
        break;
      case "j":
      case "J":
      case "C":
        throw new RangeError("`j/J/C` (hour) patterns are not supported, use `h/H/K/k` instead");
      case "m":
        result.minute = ["numeric", "2-digit"][len - 1];
        break;
      case "s":
        result.second = ["numeric", "2-digit"][len - 1];
        break;
      case "S":
      case "A":
        throw new RangeError("`S/A` (second) patterns are not supported, use `s` instead");
      case "z":
        result.timeZoneName = len < 4 ? "short" : "long";
        break;
      case "Z":
      case "O":
      case "v":
      case "V":
      case "X":
      case "x":
        throw new RangeError("`Z/O/v/V/X/x` (timeZone) patterns are not supported, use `z` instead");
    }
    return "";
  });
  return result;
}
var WHITE_SPACE_REGEX = /[\t-\r \x85\u200E\u200F\u2028\u2029]/i;
function parseNumberSkeletonFromString(skeleton) {
  if (skeleton.length === 0) {
    throw new Error("Number skeleton cannot be empty");
  }
  var stringTokens = skeleton.split(WHITE_SPACE_REGEX).filter(function(x) {
    return x.length > 0;
  });
  var tokens = [];
  for (var _i = 0, stringTokens_1 = stringTokens; _i < stringTokens_1.length; _i++) {
    var stringToken = stringTokens_1[_i];
    var stemAndOptions = stringToken.split("/");
    if (stemAndOptions.length === 0) {
      throw new Error("Invalid number skeleton");
    }
    var stem = stemAndOptions[0], options = stemAndOptions.slice(1);
    for (var _a2 = 0, options_1 = options; _a2 < options_1.length; _a2++) {
      var option = options_1[_a2];
      if (option.length === 0) {
        throw new Error("Invalid number skeleton");
      }
    }
    tokens.push({ stem, options });
  }
  return tokens;
}
function icuUnitToEcma(unit) {
  return unit.replace(/^(.*?)-/, "");
}
var FRACTION_PRECISION_REGEX = /^\.(?:(0+)(\*)?|(#+)|(0+)(#+))$/g;
var SIGNIFICANT_PRECISION_REGEX = /^(@+)?(\+|#+)?$/g;
var INTEGER_WIDTH_REGEX = /(\*)(0+)|(#+)(0+)|(0+)/g;
var CONCISE_INTEGER_WIDTH_REGEX = /^(0+)$/;
function parseSignificantPrecision(str) {
  var result = {};
  str.replace(SIGNIFICANT_PRECISION_REGEX, function(_, g1, g2) {
    if (typeof g2 !== "string") {
      result.minimumSignificantDigits = g1.length;
      result.maximumSignificantDigits = g1.length;
    } else if (g2 === "+") {
      result.minimumSignificantDigits = g1.length;
    } else if (g1[0] === "#") {
      result.maximumSignificantDigits = g1.length;
    } else {
      result.minimumSignificantDigits = g1.length;
      result.maximumSignificantDigits = g1.length + (typeof g2 === "string" ? g2.length : 0);
    }
    return "";
  });
  return result;
}
function parseSign(str) {
  switch (str) {
    case "sign-auto":
      return {
        signDisplay: "auto"
      };
    case "sign-accounting":
    case "()":
      return {
        currencySign: "accounting"
      };
    case "sign-always":
    case "+!":
      return {
        signDisplay: "always"
      };
    case "sign-accounting-always":
    case "()!":
      return {
        signDisplay: "always",
        currencySign: "accounting"
      };
    case "sign-except-zero":
    case "+?":
      return {
        signDisplay: "exceptZero"
      };
    case "sign-accounting-except-zero":
    case "()?":
      return {
        signDisplay: "exceptZero",
        currencySign: "accounting"
      };
    case "sign-never":
    case "+_":
      return {
        signDisplay: "never"
      };
  }
}
function parseConciseScientificAndEngineeringStem(stem) {
  var result;
  if (stem[0] === "E" && stem[1] === "E") {
    result = {
      notation: "engineering"
    };
    stem = stem.slice(2);
  } else if (stem[0] === "E") {
    result = {
      notation: "scientific"
    };
    stem = stem.slice(1);
  }
  if (result) {
    var signDisplay = stem.slice(0, 2);
    if (signDisplay === "+!") {
      result.signDisplay = "always";
      stem = stem.slice(2);
    } else if (signDisplay === "+?") {
      result.signDisplay = "exceptZero";
      stem = stem.slice(2);
    }
    if (!CONCISE_INTEGER_WIDTH_REGEX.test(stem)) {
      throw new Error("Malformed concise eng/scientific notation");
    }
    result.minimumIntegerDigits = stem.length;
  }
  return result;
}
function parseNotationOptions(opt) {
  var result = {};
  var signOpts = parseSign(opt);
  if (signOpts) {
    return signOpts;
  }
  return result;
}
function parseNumberSkeleton(tokens) {
  var result = {};
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    switch (token.stem) {
      case "percent":
      case "%":
        result.style = "percent";
        continue;
      case "%x100":
        result.style = "percent";
        result.scale = 100;
        continue;
      case "currency":
        result.style = "currency";
        result.currency = token.options[0];
        continue;
      case "group-off":
      case ",_":
        result.useGrouping = false;
        continue;
      case "precision-integer":
      case ".":
        result.maximumFractionDigits = 0;
        continue;
      case "measure-unit":
      case "unit":
        result.style = "unit";
        result.unit = icuUnitToEcma(token.options[0]);
        continue;
      case "compact-short":
      case "K":
        result.notation = "compact";
        result.compactDisplay = "short";
        continue;
      case "compact-long":
      case "KK":
        result.notation = "compact";
        result.compactDisplay = "long";
        continue;
      case "scientific":
        result = __assign(__assign(__assign({}, result), { notation: "scientific" }), token.options.reduce(function(all, opt) {
          return __assign(__assign({}, all), parseNotationOptions(opt));
        }, {}));
        continue;
      case "engineering":
        result = __assign(__assign(__assign({}, result), { notation: "engineering" }), token.options.reduce(function(all, opt) {
          return __assign(__assign({}, all), parseNotationOptions(opt));
        }, {}));
        continue;
      case "notation-simple":
        result.notation = "standard";
        continue;
      case "unit-width-narrow":
        result.currencyDisplay = "narrowSymbol";
        result.unitDisplay = "narrow";
        continue;
      case "unit-width-short":
        result.currencyDisplay = "code";
        result.unitDisplay = "short";
        continue;
      case "unit-width-full-name":
        result.currencyDisplay = "name";
        result.unitDisplay = "long";
        continue;
      case "unit-width-iso-code":
        result.currencyDisplay = "symbol";
        continue;
      case "scale":
        result.scale = parseFloat(token.options[0]);
        continue;
      case "integer-width":
        if (token.options.length > 1) {
          throw new RangeError("integer-width stems only accept a single optional option");
        }
        token.options[0].replace(INTEGER_WIDTH_REGEX, function(_, g1, g2, g3, g4, g5) {
          if (g1) {
            result.minimumIntegerDigits = g2.length;
          } else if (g3 && g4) {
            throw new Error("We currently do not support maximum integer digits");
          } else if (g5) {
            throw new Error("We currently do not support exact integer digits");
          }
          return "";
        });
        continue;
    }
    if (CONCISE_INTEGER_WIDTH_REGEX.test(token.stem)) {
      result.minimumIntegerDigits = token.stem.length;
      continue;
    }
    if (FRACTION_PRECISION_REGEX.test(token.stem)) {
      if (token.options.length > 1) {
        throw new RangeError("Fraction-precision stems only accept a single optional option");
      }
      token.stem.replace(FRACTION_PRECISION_REGEX, function(_, g1, g2, g3, g4, g5) {
        if (g2 === "*") {
          result.minimumFractionDigits = g1.length;
        } else if (g3 && g3[0] === "#") {
          result.maximumFractionDigits = g3.length;
        } else if (g4 && g5) {
          result.minimumFractionDigits = g4.length;
          result.maximumFractionDigits = g4.length + g5.length;
        } else {
          result.minimumFractionDigits = g1.length;
          result.maximumFractionDigits = g1.length;
        }
        return "";
      });
      if (token.options.length) {
        result = __assign(__assign({}, result), parseSignificantPrecision(token.options[0]));
      }
      continue;
    }
    if (SIGNIFICANT_PRECISION_REGEX.test(token.stem)) {
      result = __assign(__assign({}, result), parseSignificantPrecision(token.stem));
      continue;
    }
    var signOpts = parseSign(token.stem);
    if (signOpts) {
      result = __assign(__assign({}, result), signOpts);
    }
    var conciseScientificAndEngineeringOpts = parseConciseScientificAndEngineeringStem(token.stem);
    if (conciseScientificAndEngineeringOpts) {
      result = __assign(__assign({}, result), conciseScientificAndEngineeringOpts);
    }
  }
  return result;
}
var _a;
var SPACE_SEPARATOR_START_REGEX = new RegExp("^" + SPACE_SEPARATOR_REGEX.source + "*");
var SPACE_SEPARATOR_END_REGEX = new RegExp(SPACE_SEPARATOR_REGEX.source + "*$");
function createLocation(start, end) {
  return { start, end };
}
var hasNativeStartsWith = !!String.prototype.startsWith;
var hasNativeFromCodePoint = !!String.fromCodePoint;
var hasNativeFromEntries = !!Object.fromEntries;
var hasNativeCodePointAt = !!String.prototype.codePointAt;
var hasTrimStart = !!String.prototype.trimStart;
var hasTrimEnd = !!String.prototype.trimEnd;
var hasNativeIsSafeInteger = !!Number.isSafeInteger;
var isSafeInteger = hasNativeIsSafeInteger ? Number.isSafeInteger : function(n) {
  return typeof n === "number" && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
};
var REGEX_SUPPORTS_U_AND_Y = true;
try {
  re = RE("([^\\p{White_Space}\\p{Pattern_Syntax}]*)", "yu");
  REGEX_SUPPORTS_U_AND_Y = ((_a = re.exec("a")) === null || _a === void 0 ? void 0 : _a[0]) === "a";
} catch (_) {
  REGEX_SUPPORTS_U_AND_Y = false;
}
var re;
var startsWith = hasNativeStartsWith ? function startsWith2(s, search, position) {
  return s.startsWith(search, position);
} : function startsWith3(s, search, position) {
  return s.slice(position, position + search.length) === search;
};
var fromCodePoint = hasNativeFromCodePoint ? String.fromCodePoint : function fromCodePoint2() {
  var codePoints = [];
  for (var _i = 0; _i < arguments.length; _i++) {
    codePoints[_i] = arguments[_i];
  }
  var elements = "";
  var length = codePoints.length;
  var i = 0;
  var code;
  while (length > i) {
    code = codePoints[i++];
    if (code > 1114111)
      throw RangeError(code + " is not a valid code point");
    elements += code < 65536 ? String.fromCharCode(code) : String.fromCharCode(((code -= 65536) >> 10) + 55296, code % 1024 + 56320);
  }
  return elements;
};
var fromEntries = hasNativeFromEntries ? Object.fromEntries : function fromEntries2(entries) {
  var obj = {};
  for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
    var _a2 = entries_1[_i], k = _a2[0], v = _a2[1];
    obj[k] = v;
  }
  return obj;
};
var codePointAt = hasNativeCodePointAt ? function codePointAt2(s, index) {
  return s.codePointAt(index);
} : function codePointAt3(s, index) {
  var size = s.length;
  if (index < 0 || index >= size) {
    return void 0;
  }
  var first = s.charCodeAt(index);
  var second;
  return first < 55296 || first > 56319 || index + 1 === size || (second = s.charCodeAt(index + 1)) < 56320 || second > 57343 ? first : (first - 55296 << 10) + (second - 56320) + 65536;
};
var trimStart = hasTrimStart ? function trimStart2(s) {
  return s.trimStart();
} : function trimStart3(s) {
  return s.replace(SPACE_SEPARATOR_START_REGEX, "");
};
var trimEnd = hasTrimEnd ? function trimEnd2(s) {
  return s.trimEnd();
} : function trimEnd3(s) {
  return s.replace(SPACE_SEPARATOR_END_REGEX, "");
};
function RE(s, flag) {
  return new RegExp(s, flag);
}
var matchIdentifierAtIndex;
if (REGEX_SUPPORTS_U_AND_Y) {
  IDENTIFIER_PREFIX_RE_1 = RE("([^\\p{White_Space}\\p{Pattern_Syntax}]*)", "yu");
  matchIdentifierAtIndex = function matchIdentifierAtIndex2(s, index) {
    var _a2;
    IDENTIFIER_PREFIX_RE_1.lastIndex = index;
    var match = IDENTIFIER_PREFIX_RE_1.exec(s);
    return (_a2 = match[1]) !== null && _a2 !== void 0 ? _a2 : "";
  };
} else {
  matchIdentifierAtIndex = function matchIdentifierAtIndex2(s, index) {
    var match = [];
    while (true) {
      var c = codePointAt(s, index);
      if (c === void 0 || _isWhiteSpace(c) || _isPatternSyntax(c)) {
        break;
      }
      match.push(c);
      index += c >= 65536 ? 2 : 1;
    }
    return fromCodePoint.apply(void 0, match);
  };
}
var IDENTIFIER_PREFIX_RE_1;
var Parser = (function() {
  function Parser2(message, options) {
    if (options === void 0) {
      options = {};
    }
    this.message = message;
    this.position = { offset: 0, line: 1, column: 1 };
    this.ignoreTag = !!options.ignoreTag;
    this.requiresOtherClause = !!options.requiresOtherClause;
    this.shouldParseSkeletons = !!options.shouldParseSkeletons;
  }
  Parser2.prototype.parse = function() {
    if (this.offset() !== 0) {
      throw Error("parser can only be used once");
    }
    return this.parseMessage(0, "", false);
  };
  Parser2.prototype.parseMessage = function(nestingLevel, parentArgType, expectingCloseTag) {
    var elements = [];
    while (!this.isEOF()) {
      var char = this.char();
      if (char === 123) {
        var result = this.parseArgument(nestingLevel, expectingCloseTag);
        if (result.err) {
          return result;
        }
        elements.push(result.val);
      } else if (char === 125 && nestingLevel > 0) {
        break;
      } else if (char === 35 && (parentArgType === "plural" || parentArgType === "selectordinal")) {
        var position = this.clonePosition();
        this.bump();
        elements.push({
          type: TYPE.pound,
          location: createLocation(position, this.clonePosition())
        });
      } else if (char === 60 && !this.ignoreTag && this.peek() === 47) {
        if (expectingCloseTag) {
          break;
        } else {
          return this.error(ErrorKind.UNMATCHED_CLOSING_TAG, createLocation(this.clonePosition(), this.clonePosition()));
        }
      } else if (char === 60 && !this.ignoreTag && _isAlpha(this.peek() || 0)) {
        var result = this.parseTag(nestingLevel, parentArgType);
        if (result.err) {
          return result;
        }
        elements.push(result.val);
      } else {
        var result = this.parseLiteral(nestingLevel, parentArgType);
        if (result.err) {
          return result;
        }
        elements.push(result.val);
      }
    }
    return { val: elements, err: null };
  };
  Parser2.prototype.parseTag = function(nestingLevel, parentArgType) {
    var startPosition = this.clonePosition();
    this.bump();
    var tagName = this.parseTagName();
    this.bumpSpace();
    if (this.bumpIf("/>")) {
      return {
        val: {
          type: TYPE.literal,
          value: "<" + tagName + "/>",
          location: createLocation(startPosition, this.clonePosition())
        },
        err: null
      };
    } else if (this.bumpIf(">")) {
      var childrenResult = this.parseMessage(nestingLevel + 1, parentArgType, true);
      if (childrenResult.err) {
        return childrenResult;
      }
      var children = childrenResult.val;
      var endTagStartPosition = this.clonePosition();
      if (this.bumpIf("</")) {
        if (this.isEOF() || !_isAlpha(this.char())) {
          return this.error(ErrorKind.INVALID_TAG, createLocation(endTagStartPosition, this.clonePosition()));
        }
        var closingTagNameStartPosition = this.clonePosition();
        var closingTagName = this.parseTagName();
        if (tagName !== closingTagName) {
          return this.error(ErrorKind.UNMATCHED_CLOSING_TAG, createLocation(closingTagNameStartPosition, this.clonePosition()));
        }
        this.bumpSpace();
        if (!this.bumpIf(">")) {
          return this.error(ErrorKind.INVALID_TAG, createLocation(endTagStartPosition, this.clonePosition()));
        }
        return {
          val: {
            type: TYPE.tag,
            value: tagName,
            children,
            location: createLocation(startPosition, this.clonePosition())
          },
          err: null
        };
      } else {
        return this.error(ErrorKind.UNCLOSED_TAG, createLocation(startPosition, this.clonePosition()));
      }
    } else {
      return this.error(ErrorKind.INVALID_TAG, createLocation(startPosition, this.clonePosition()));
    }
  };
  Parser2.prototype.parseTagName = function() {
    var startOffset = this.offset();
    this.bump();
    while (!this.isEOF() && _isPotentialElementNameChar(this.char())) {
      this.bump();
    }
    return this.message.slice(startOffset, this.offset());
  };
  Parser2.prototype.parseLiteral = function(nestingLevel, parentArgType) {
    var start = this.clonePosition();
    var value = "";
    while (true) {
      var parseQuoteResult = this.tryParseQuote(parentArgType);
      if (parseQuoteResult) {
        value += parseQuoteResult;
        continue;
      }
      var parseUnquotedResult = this.tryParseUnquoted(nestingLevel, parentArgType);
      if (parseUnquotedResult) {
        value += parseUnquotedResult;
        continue;
      }
      var parseLeftAngleResult = this.tryParseLeftAngleBracket();
      if (parseLeftAngleResult) {
        value += parseLeftAngleResult;
        continue;
      }
      break;
    }
    var location = createLocation(start, this.clonePosition());
    return {
      val: { type: TYPE.literal, value, location },
      err: null
    };
  };
  Parser2.prototype.tryParseLeftAngleBracket = function() {
    if (!this.isEOF() && this.char() === 60 && (this.ignoreTag || !_isAlphaOrSlash(this.peek() || 0))) {
      this.bump();
      return "<";
    }
    return null;
  };
  Parser2.prototype.tryParseQuote = function(parentArgType) {
    if (this.isEOF() || this.char() !== 39) {
      return null;
    }
    switch (this.peek()) {
      case 39:
        this.bump();
        this.bump();
        return "'";
      case 123:
      case 60:
      case 62:
      case 125:
        break;
      case 35:
        if (parentArgType === "plural" || parentArgType === "selectordinal") {
          break;
        }
        return null;
      default:
        return null;
    }
    this.bump();
    var codePoints = [this.char()];
    this.bump();
    while (!this.isEOF()) {
      var ch = this.char();
      if (ch === 39) {
        if (this.peek() === 39) {
          codePoints.push(39);
          this.bump();
        } else {
          this.bump();
          break;
        }
      } else {
        codePoints.push(ch);
      }
      this.bump();
    }
    return fromCodePoint.apply(void 0, codePoints);
  };
  Parser2.prototype.tryParseUnquoted = function(nestingLevel, parentArgType) {
    if (this.isEOF()) {
      return null;
    }
    var ch = this.char();
    if (ch === 60 || ch === 123 || ch === 35 && (parentArgType === "plural" || parentArgType === "selectordinal") || ch === 125 && nestingLevel > 0) {
      return null;
    } else {
      this.bump();
      return fromCodePoint(ch);
    }
  };
  Parser2.prototype.parseArgument = function(nestingLevel, expectingCloseTag) {
    var openingBracePosition = this.clonePosition();
    this.bump();
    this.bumpSpace();
    if (this.isEOF()) {
      return this.error(ErrorKind.EXPECT_ARGUMENT_CLOSING_BRACE, createLocation(openingBracePosition, this.clonePosition()));
    }
    if (this.char() === 125) {
      this.bump();
      return this.error(ErrorKind.EMPTY_ARGUMENT, createLocation(openingBracePosition, this.clonePosition()));
    }
    var value = this.parseIdentifierIfPossible().value;
    if (!value) {
      return this.error(ErrorKind.MALFORMED_ARGUMENT, createLocation(openingBracePosition, this.clonePosition()));
    }
    this.bumpSpace();
    if (this.isEOF()) {
      return this.error(ErrorKind.EXPECT_ARGUMENT_CLOSING_BRACE, createLocation(openingBracePosition, this.clonePosition()));
    }
    switch (this.char()) {
      case 125: {
        this.bump();
        return {
          val: {
            type: TYPE.argument,
            value,
            location: createLocation(openingBracePosition, this.clonePosition())
          },
          err: null
        };
      }
      case 44: {
        this.bump();
        this.bumpSpace();
        if (this.isEOF()) {
          return this.error(ErrorKind.EXPECT_ARGUMENT_CLOSING_BRACE, createLocation(openingBracePosition, this.clonePosition()));
        }
        return this.parseArgumentOptions(nestingLevel, expectingCloseTag, value, openingBracePosition);
      }
      default:
        return this.error(ErrorKind.MALFORMED_ARGUMENT, createLocation(openingBracePosition, this.clonePosition()));
    }
  };
  Parser2.prototype.parseIdentifierIfPossible = function() {
    var startingPosition = this.clonePosition();
    var startOffset = this.offset();
    var value = matchIdentifierAtIndex(this.message, startOffset);
    var endOffset = startOffset + value.length;
    this.bumpTo(endOffset);
    var endPosition = this.clonePosition();
    var location = createLocation(startingPosition, endPosition);
    return { value, location };
  };
  Parser2.prototype.parseArgumentOptions = function(nestingLevel, expectingCloseTag, value, openingBracePosition) {
    var _a2;
    var typeStartPosition = this.clonePosition();
    var argType = this.parseIdentifierIfPossible().value;
    var typeEndPosition = this.clonePosition();
    switch (argType) {
      case "":
        return this.error(ErrorKind.EXPECT_ARGUMENT_TYPE, createLocation(typeStartPosition, typeEndPosition));
      case "number":
      case "date":
      case "time": {
        this.bumpSpace();
        var styleAndLocation = null;
        if (this.bumpIf(",")) {
          this.bumpSpace();
          var styleStartPosition = this.clonePosition();
          var result = this.parseSimpleArgStyleIfPossible();
          if (result.err) {
            return result;
          }
          var style = trimEnd(result.val);
          if (style.length === 0) {
            return this.error(ErrorKind.EXPECT_ARGUMENT_STYLE, createLocation(this.clonePosition(), this.clonePosition()));
          }
          var styleLocation = createLocation(styleStartPosition, this.clonePosition());
          styleAndLocation = { style, styleLocation };
        }
        var argCloseResult = this.tryParseArgumentClose(openingBracePosition);
        if (argCloseResult.err) {
          return argCloseResult;
        }
        var location_1 = createLocation(openingBracePosition, this.clonePosition());
        if (styleAndLocation && startsWith(styleAndLocation === null || styleAndLocation === void 0 ? void 0 : styleAndLocation.style, "::", 0)) {
          var skeleton = trimStart(styleAndLocation.style.slice(2));
          if (argType === "number") {
            var result = this.parseNumberSkeletonFromString(skeleton, styleAndLocation.styleLocation);
            if (result.err) {
              return result;
            }
            return {
              val: { type: TYPE.number, value, location: location_1, style: result.val },
              err: null
            };
          } else {
            if (skeleton.length === 0) {
              return this.error(ErrorKind.EXPECT_DATE_TIME_SKELETON, location_1);
            }
            var style = {
              type: SKELETON_TYPE.dateTime,
              pattern: skeleton,
              location: styleAndLocation.styleLocation,
              parsedOptions: this.shouldParseSkeletons ? parseDateTimeSkeleton(skeleton) : {}
            };
            var type = argType === "date" ? TYPE.date : TYPE.time;
            return {
              val: { type, value, location: location_1, style },
              err: null
            };
          }
        }
        return {
          val: {
            type: argType === "number" ? TYPE.number : argType === "date" ? TYPE.date : TYPE.time,
            value,
            location: location_1,
            style: (_a2 = styleAndLocation === null || styleAndLocation === void 0 ? void 0 : styleAndLocation.style) !== null && _a2 !== void 0 ? _a2 : null
          },
          err: null
        };
      }
      case "plural":
      case "selectordinal":
      case "select": {
        var typeEndPosition_1 = this.clonePosition();
        this.bumpSpace();
        if (!this.bumpIf(",")) {
          return this.error(ErrorKind.EXPECT_SELECT_ARGUMENT_OPTIONS, createLocation(typeEndPosition_1, __assign({}, typeEndPosition_1)));
        }
        this.bumpSpace();
        var identifierAndLocation = this.parseIdentifierIfPossible();
        var pluralOffset = 0;
        if (argType !== "select" && identifierAndLocation.value === "offset") {
          if (!this.bumpIf(":")) {
            return this.error(ErrorKind.EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE, createLocation(this.clonePosition(), this.clonePosition()));
          }
          this.bumpSpace();
          var result = this.tryParseDecimalInteger(ErrorKind.EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE, ErrorKind.INVALID_PLURAL_ARGUMENT_OFFSET_VALUE);
          if (result.err) {
            return result;
          }
          this.bumpSpace();
          identifierAndLocation = this.parseIdentifierIfPossible();
          pluralOffset = result.val;
        }
        var optionsResult = this.tryParsePluralOrSelectOptions(nestingLevel, argType, expectingCloseTag, identifierAndLocation);
        if (optionsResult.err) {
          return optionsResult;
        }
        var argCloseResult = this.tryParseArgumentClose(openingBracePosition);
        if (argCloseResult.err) {
          return argCloseResult;
        }
        var location_2 = createLocation(openingBracePosition, this.clonePosition());
        if (argType === "select") {
          return {
            val: {
              type: TYPE.select,
              value,
              options: fromEntries(optionsResult.val),
              location: location_2
            },
            err: null
          };
        } else {
          return {
            val: {
              type: TYPE.plural,
              value,
              options: fromEntries(optionsResult.val),
              offset: pluralOffset,
              pluralType: argType === "plural" ? "cardinal" : "ordinal",
              location: location_2
            },
            err: null
          };
        }
      }
      default:
        return this.error(ErrorKind.INVALID_ARGUMENT_TYPE, createLocation(typeStartPosition, typeEndPosition));
    }
  };
  Parser2.prototype.tryParseArgumentClose = function(openingBracePosition) {
    if (this.isEOF() || this.char() !== 125) {
      return this.error(ErrorKind.EXPECT_ARGUMENT_CLOSING_BRACE, createLocation(openingBracePosition, this.clonePosition()));
    }
    this.bump();
    return { val: true, err: null };
  };
  Parser2.prototype.parseSimpleArgStyleIfPossible = function() {
    var nestedBraces = 0;
    var startPosition = this.clonePosition();
    while (!this.isEOF()) {
      var ch = this.char();
      switch (ch) {
        case 39: {
          this.bump();
          var apostrophePosition = this.clonePosition();
          if (!this.bumpUntil("'")) {
            return this.error(ErrorKind.UNCLOSED_QUOTE_IN_ARGUMENT_STYLE, createLocation(apostrophePosition, this.clonePosition()));
          }
          this.bump();
          break;
        }
        case 123: {
          nestedBraces += 1;
          this.bump();
          break;
        }
        case 125: {
          if (nestedBraces > 0) {
            nestedBraces -= 1;
          } else {
            return {
              val: this.message.slice(startPosition.offset, this.offset()),
              err: null
            };
          }
          break;
        }
        default:
          this.bump();
          break;
      }
    }
    return {
      val: this.message.slice(startPosition.offset, this.offset()),
      err: null
    };
  };
  Parser2.prototype.parseNumberSkeletonFromString = function(skeleton, location) {
    var tokens = [];
    try {
      tokens = parseNumberSkeletonFromString(skeleton);
    } catch (e) {
      return this.error(ErrorKind.INVALID_NUMBER_SKELETON, location);
    }
    return {
      val: {
        type: SKELETON_TYPE.number,
        tokens,
        location,
        parsedOptions: this.shouldParseSkeletons ? parseNumberSkeleton(tokens) : {}
      },
      err: null
    };
  };
  Parser2.prototype.tryParsePluralOrSelectOptions = function(nestingLevel, parentArgType, expectCloseTag, parsedFirstIdentifier) {
    var _a2;
    var hasOtherClause = false;
    var options = [];
    var parsedSelectors = /* @__PURE__ */ new Set();
    var selector = parsedFirstIdentifier.value, selectorLocation = parsedFirstIdentifier.location;
    while (true) {
      if (selector.length === 0) {
        var startPosition = this.clonePosition();
        if (parentArgType !== "select" && this.bumpIf("=")) {
          var result = this.tryParseDecimalInteger(ErrorKind.EXPECT_PLURAL_ARGUMENT_SELECTOR, ErrorKind.INVALID_PLURAL_ARGUMENT_SELECTOR);
          if (result.err) {
            return result;
          }
          selectorLocation = createLocation(startPosition, this.clonePosition());
          selector = this.message.slice(startPosition.offset, this.offset());
        } else {
          break;
        }
      }
      if (parsedSelectors.has(selector)) {
        return this.error(parentArgType === "select" ? ErrorKind.DUPLICATE_SELECT_ARGUMENT_SELECTOR : ErrorKind.DUPLICATE_PLURAL_ARGUMENT_SELECTOR, selectorLocation);
      }
      if (selector === "other") {
        hasOtherClause = true;
      }
      this.bumpSpace();
      var openingBracePosition = this.clonePosition();
      if (!this.bumpIf("{")) {
        return this.error(parentArgType === "select" ? ErrorKind.EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT : ErrorKind.EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT, createLocation(this.clonePosition(), this.clonePosition()));
      }
      var fragmentResult = this.parseMessage(nestingLevel + 1, parentArgType, expectCloseTag);
      if (fragmentResult.err) {
        return fragmentResult;
      }
      var argCloseResult = this.tryParseArgumentClose(openingBracePosition);
      if (argCloseResult.err) {
        return argCloseResult;
      }
      options.push([
        selector,
        {
          value: fragmentResult.val,
          location: createLocation(openingBracePosition, this.clonePosition())
        }
      ]);
      parsedSelectors.add(selector);
      this.bumpSpace();
      _a2 = this.parseIdentifierIfPossible(), selector = _a2.value, selectorLocation = _a2.location;
    }
    if (options.length === 0) {
      return this.error(parentArgType === "select" ? ErrorKind.EXPECT_SELECT_ARGUMENT_SELECTOR : ErrorKind.EXPECT_PLURAL_ARGUMENT_SELECTOR, createLocation(this.clonePosition(), this.clonePosition()));
    }
    if (this.requiresOtherClause && !hasOtherClause) {
      return this.error(ErrorKind.MISSING_OTHER_CLAUSE, createLocation(this.clonePosition(), this.clonePosition()));
    }
    return { val: options, err: null };
  };
  Parser2.prototype.tryParseDecimalInteger = function(expectNumberError, invalidNumberError) {
    var sign = 1;
    var startingPosition = this.clonePosition();
    if (this.bumpIf("+")) {
    } else if (this.bumpIf("-")) {
      sign = -1;
    }
    var hasDigits = false;
    var decimal = 0;
    while (!this.isEOF()) {
      var ch = this.char();
      if (ch >= 48 && ch <= 57) {
        hasDigits = true;
        decimal = decimal * 10 + (ch - 48);
        this.bump();
      } else {
        break;
      }
    }
    var location = createLocation(startingPosition, this.clonePosition());
    if (!hasDigits) {
      return this.error(expectNumberError, location);
    }
    decimal *= sign;
    if (!isSafeInteger(decimal)) {
      return this.error(invalidNumberError, location);
    }
    return { val: decimal, err: null };
  };
  Parser2.prototype.offset = function() {
    return this.position.offset;
  };
  Parser2.prototype.isEOF = function() {
    return this.offset() === this.message.length;
  };
  Parser2.prototype.clonePosition = function() {
    return {
      offset: this.position.offset,
      line: this.position.line,
      column: this.position.column
    };
  };
  Parser2.prototype.char = function() {
    var offset = this.position.offset;
    if (offset >= this.message.length) {
      throw Error("out of bound");
    }
    var code = codePointAt(this.message, offset);
    if (code === void 0) {
      throw Error("Offset " + offset + " is at invalid UTF-16 code unit boundary");
    }
    return code;
  };
  Parser2.prototype.error = function(kind, location) {
    return {
      val: null,
      err: {
        kind,
        message: this.message,
        location
      }
    };
  };
  Parser2.prototype.bump = function() {
    if (this.isEOF()) {
      return;
    }
    var code = this.char();
    if (code === 10) {
      this.position.line += 1;
      this.position.column = 1;
      this.position.offset += 1;
    } else {
      this.position.column += 1;
      this.position.offset += code < 65536 ? 1 : 2;
    }
  };
  Parser2.prototype.bumpIf = function(prefix) {
    if (startsWith(this.message, prefix, this.offset())) {
      for (var i = 0; i < prefix.length; i++) {
        this.bump();
      }
      return true;
    }
    return false;
  };
  Parser2.prototype.bumpUntil = function(pattern) {
    var currentOffset = this.offset();
    var index = this.message.indexOf(pattern, currentOffset);
    if (index >= 0) {
      this.bumpTo(index);
      return true;
    } else {
      this.bumpTo(this.message.length);
      return false;
    }
  };
  Parser2.prototype.bumpTo = function(targetOffset) {
    if (this.offset() > targetOffset) {
      throw Error("targetOffset " + targetOffset + " must be greater than or equal to the current offset " + this.offset());
    }
    targetOffset = Math.min(targetOffset, this.message.length);
    while (true) {
      var offset = this.offset();
      if (offset === targetOffset) {
        break;
      }
      if (offset > targetOffset) {
        throw Error("targetOffset " + targetOffset + " is at invalid UTF-16 code unit boundary");
      }
      this.bump();
      if (this.isEOF()) {
        break;
      }
    }
  };
  Parser2.prototype.bumpSpace = function() {
    while (!this.isEOF() && _isWhiteSpace(this.char())) {
      this.bump();
    }
  };
  Parser2.prototype.peek = function() {
    if (this.isEOF()) {
      return null;
    }
    var code = this.char();
    var offset = this.offset();
    var nextCode = this.message.charCodeAt(offset + (code >= 65536 ? 2 : 1));
    return nextCode !== null && nextCode !== void 0 ? nextCode : null;
  };
  return Parser2;
})();
function _isAlpha(codepoint) {
  return codepoint >= 97 && codepoint <= 122 || codepoint >= 65 && codepoint <= 90;
}
function _isAlphaOrSlash(codepoint) {
  return _isAlpha(codepoint) || codepoint === 47;
}
function _isPotentialElementNameChar(c) {
  return c === 45 || c === 46 || c >= 48 && c <= 57 || c === 95 || c >= 97 && c <= 122 || c >= 65 && c <= 90 || c == 183 || c >= 192 && c <= 214 || c >= 216 && c <= 246 || c >= 248 && c <= 893 || c >= 895 && c <= 8191 || c >= 8204 && c <= 8205 || c >= 8255 && c <= 8256 || c >= 8304 && c <= 8591 || c >= 11264 && c <= 12271 || c >= 12289 && c <= 55295 || c >= 63744 && c <= 64975 || c >= 65008 && c <= 65533 || c >= 65536 && c <= 983039;
}
function _isWhiteSpace(c) {
  return c >= 9 && c <= 13 || c === 32 || c === 133 || c >= 8206 && c <= 8207 || c === 8232 || c === 8233;
}
function _isPatternSyntax(c) {
  return c >= 33 && c <= 35 || c === 36 || c >= 37 && c <= 39 || c === 40 || c === 41 || c === 42 || c === 43 || c === 44 || c === 45 || c >= 46 && c <= 47 || c >= 58 && c <= 59 || c >= 60 && c <= 62 || c >= 63 && c <= 64 || c === 91 || c === 92 || c === 93 || c === 94 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 161 || c >= 162 && c <= 165 || c === 166 || c === 167 || c === 169 || c === 171 || c === 172 || c === 174 || c === 176 || c === 177 || c === 182 || c === 187 || c === 191 || c === 215 || c === 247 || c >= 8208 && c <= 8213 || c >= 8214 && c <= 8215 || c === 8216 || c === 8217 || c === 8218 || c >= 8219 && c <= 8220 || c === 8221 || c === 8222 || c === 8223 || c >= 8224 && c <= 8231 || c >= 8240 && c <= 8248 || c === 8249 || c === 8250 || c >= 8251 && c <= 8254 || c >= 8257 && c <= 8259 || c === 8260 || c === 8261 || c === 8262 || c >= 8263 && c <= 8273 || c === 8274 || c === 8275 || c >= 8277 && c <= 8286 || c >= 8592 && c <= 8596 || c >= 8597 && c <= 8601 || c >= 8602 && c <= 8603 || c >= 8604 && c <= 8607 || c === 8608 || c >= 8609 && c <= 8610 || c === 8611 || c >= 8612 && c <= 8613 || c === 8614 || c >= 8615 && c <= 8621 || c === 8622 || c >= 8623 && c <= 8653 || c >= 8654 && c <= 8655 || c >= 8656 && c <= 8657 || c === 8658 || c === 8659 || c === 8660 || c >= 8661 && c <= 8691 || c >= 8692 && c <= 8959 || c >= 8960 && c <= 8967 || c === 8968 || c === 8969 || c === 8970 || c === 8971 || c >= 8972 && c <= 8991 || c >= 8992 && c <= 8993 || c >= 8994 && c <= 9e3 || c === 9001 || c === 9002 || c >= 9003 && c <= 9083 || c === 9084 || c >= 9085 && c <= 9114 || c >= 9115 && c <= 9139 || c >= 9140 && c <= 9179 || c >= 9180 && c <= 9185 || c >= 9186 && c <= 9254 || c >= 9255 && c <= 9279 || c >= 9280 && c <= 9290 || c >= 9291 && c <= 9311 || c >= 9472 && c <= 9654 || c === 9655 || c >= 9656 && c <= 9664 || c === 9665 || c >= 9666 && c <= 9719 || c >= 9720 && c <= 9727 || c >= 9728 && c <= 9838 || c === 9839 || c >= 9840 && c <= 10087 || c === 10088 || c === 10089 || c === 10090 || c === 10091 || c === 10092 || c === 10093 || c === 10094 || c === 10095 || c === 10096 || c === 10097 || c === 10098 || c === 10099 || c === 10100 || c === 10101 || c >= 10132 && c <= 10175 || c >= 10176 && c <= 10180 || c === 10181 || c === 10182 || c >= 10183 && c <= 10213 || c === 10214 || c === 10215 || c === 10216 || c === 10217 || c === 10218 || c === 10219 || c === 10220 || c === 10221 || c === 10222 || c === 10223 || c >= 10224 && c <= 10239 || c >= 10240 && c <= 10495 || c >= 10496 && c <= 10626 || c === 10627 || c === 10628 || c === 10629 || c === 10630 || c === 10631 || c === 10632 || c === 10633 || c === 10634 || c === 10635 || c === 10636 || c === 10637 || c === 10638 || c === 10639 || c === 10640 || c === 10641 || c === 10642 || c === 10643 || c === 10644 || c === 10645 || c === 10646 || c === 10647 || c === 10648 || c >= 10649 && c <= 10711 || c === 10712 || c === 10713 || c === 10714 || c === 10715 || c >= 10716 && c <= 10747 || c === 10748 || c === 10749 || c >= 10750 && c <= 11007 || c >= 11008 && c <= 11055 || c >= 11056 && c <= 11076 || c >= 11077 && c <= 11078 || c >= 11079 && c <= 11084 || c >= 11085 && c <= 11123 || c >= 11124 && c <= 11125 || c >= 11126 && c <= 11157 || c === 11158 || c >= 11159 && c <= 11263 || c >= 11776 && c <= 11777 || c === 11778 || c === 11779 || c === 11780 || c === 11781 || c >= 11782 && c <= 11784 || c === 11785 || c === 11786 || c === 11787 || c === 11788 || c === 11789 || c >= 11790 && c <= 11798 || c === 11799 || c >= 11800 && c <= 11801 || c === 11802 || c === 11803 || c === 11804 || c === 11805 || c >= 11806 && c <= 11807 || c === 11808 || c === 11809 || c === 11810 || c === 11811 || c === 11812 || c === 11813 || c === 11814 || c === 11815 || c === 11816 || c === 11817 || c >= 11818 && c <= 11822 || c === 11823 || c >= 11824 && c <= 11833 || c >= 11834 && c <= 11835 || c >= 11836 && c <= 11839 || c === 11840 || c === 11841 || c === 11842 || c >= 11843 && c <= 11855 || c >= 11856 && c <= 11857 || c === 11858 || c >= 11859 && c <= 11903 || c >= 12289 && c <= 12291 || c === 12296 || c === 12297 || c === 12298 || c === 12299 || c === 12300 || c === 12301 || c === 12302 || c === 12303 || c === 12304 || c === 12305 || c >= 12306 && c <= 12307 || c === 12308 || c === 12309 || c === 12310 || c === 12311 || c === 12312 || c === 12313 || c === 12314 || c === 12315 || c === 12316 || c === 12317 || c >= 12318 && c <= 12319 || c === 12320 || c === 12336 || c === 64830 || c === 64831 || c >= 65093 && c <= 65094;
}
function pruneLocation(els) {
  els.forEach(function(el) {
    delete el.location;
    if (isSelectElement(el) || isPluralElement(el)) {
      for (var k in el.options) {
        delete el.options[k].location;
        pruneLocation(el.options[k].value);
      }
    } else if (isNumberElement(el) && isNumberSkeleton(el.style)) {
      delete el.style.location;
    } else if ((isDateElement(el) || isTimeElement(el)) && isDateTimeSkeleton(el.style)) {
      delete el.style.location;
    } else if (isTagElement(el)) {
      pruneLocation(el.children);
    }
  });
}
function parse(message, opts) {
  if (opts === void 0) {
    opts = {};
  }
  opts = __assign({ shouldParseSkeletons: true, requiresOtherClause: true }, opts);
  var result = new Parser(message, opts).parse();
  if (result.err) {
    var error = SyntaxError(ErrorKind[result.err.kind]);
    error.location = result.err.location;
    error.originalMessage = result.err.message;
    throw error;
  }
  if (!(opts === null || opts === void 0 ? void 0 : opts.captureLocation)) {
    pruneLocation(result.val);
  }
  return result.val;
}
function memoize(fn, options) {
  var cache = options && options.cache ? options.cache : cacheDefault;
  var serializer = options && options.serializer ? options.serializer : serializerDefault;
  var strategy = options && options.strategy ? options.strategy : strategyDefault;
  return strategy(fn, {
    cache,
    serializer
  });
}
function isPrimitive(value) {
  return value == null || typeof value === "number" || typeof value === "boolean";
}
function monadic(fn, cache, serializer, arg) {
  var cacheKey = isPrimitive(arg) ? arg : serializer(arg);
  var computedValue = cache.get(cacheKey);
  if (typeof computedValue === "undefined") {
    computedValue = fn.call(this, arg);
    cache.set(cacheKey, computedValue);
  }
  return computedValue;
}
function variadic(fn, cache, serializer) {
  var args = Array.prototype.slice.call(arguments, 3);
  var cacheKey = serializer(args);
  var computedValue = cache.get(cacheKey);
  if (typeof computedValue === "undefined") {
    computedValue = fn.apply(this, args);
    cache.set(cacheKey, computedValue);
  }
  return computedValue;
}
function assemble(fn, context, strategy, cache, serialize) {
  return strategy.bind(context, fn, cache, serialize);
}
function strategyDefault(fn, options) {
  var strategy = fn.length === 1 ? monadic : variadic;
  return assemble(fn, this, strategy, options.cache.create(), options.serializer);
}
function strategyVariadic(fn, options) {
  return assemble(fn, this, variadic, options.cache.create(), options.serializer);
}
function strategyMonadic(fn, options) {
  return assemble(fn, this, monadic, options.cache.create(), options.serializer);
}
var serializerDefault = function() {
  return JSON.stringify(arguments);
};
function ObjectWithoutPrototypeCache() {
  this.cache = /* @__PURE__ */ Object.create(null);
}
ObjectWithoutPrototypeCache.prototype.has = function(key) {
  return key in this.cache;
};
ObjectWithoutPrototypeCache.prototype.get = function(key) {
  return this.cache[key];
};
ObjectWithoutPrototypeCache.prototype.set = function(key, value) {
  this.cache[key] = value;
};
var cacheDefault = {
  create: function create() {
    return new ObjectWithoutPrototypeCache();
  }
};
var strategies = {
  variadic: strategyVariadic,
  monadic: strategyMonadic
};
var ErrorCode;
(function(ErrorCode2) {
  ErrorCode2["MISSING_VALUE"] = "MISSING_VALUE";
  ErrorCode2["INVALID_VALUE"] = "INVALID_VALUE";
  ErrorCode2["MISSING_INTL_API"] = "MISSING_INTL_API";
})(ErrorCode || (ErrorCode = {}));
var FormatError = class extends Error {
  constructor(msg, code, originalMessage) {
    super(msg);
    this.code = code;
    this.originalMessage = originalMessage;
  }
  toString() {
    return `[formatjs Error: ${this.code}] ${this.message}`;
  }
};
var InvalidValueError = class extends FormatError {
  constructor(variableId, value, options, originalMessage) {
    super(`Invalid values for "${variableId}": "${value}". Options are "${Object.keys(options).join('", "')}"`, ErrorCode.INVALID_VALUE, originalMessage);
  }
};
var InvalidValueTypeError = class extends FormatError {
  constructor(value, type, originalMessage) {
    super(`Value for "${value}" must be of type ${type}`, ErrorCode.INVALID_VALUE, originalMessage);
  }
};
var MissingValueError = class extends FormatError {
  constructor(variableId, originalMessage) {
    super(`The intl string context variable "${variableId}" was not provided to the string "${originalMessage}"`, ErrorCode.MISSING_VALUE, originalMessage);
  }
};
var PART_TYPE;
(function(PART_TYPE2) {
  PART_TYPE2[PART_TYPE2["literal"] = 0] = "literal";
  PART_TYPE2[PART_TYPE2["object"] = 1] = "object";
})(PART_TYPE || (PART_TYPE = {}));
function mergeLiteral(parts) {
  if (parts.length < 2) {
    return parts;
  }
  return parts.reduce((all, part) => {
    const lastPart = all[all.length - 1];
    if (!lastPart || lastPart.type !== PART_TYPE.literal || part.type !== PART_TYPE.literal) {
      all.push(part);
    } else {
      lastPart.value += part.value;
    }
    return all;
  }, []);
}
function isFormatXMLElementFn(el) {
  return typeof el === "function";
}
function formatToParts(els, locales, formatters, formats, values, currentPluralValue, originalMessage) {
  if (els.length === 1 && isLiteralElement(els[0])) {
    return [
      {
        type: PART_TYPE.literal,
        value: els[0].value
      }
    ];
  }
  const result = [];
  for (const el of els) {
    if (isLiteralElement(el)) {
      result.push({
        type: PART_TYPE.literal,
        value: el.value
      });
      continue;
    }
    if (isPoundElement(el)) {
      if (typeof currentPluralValue === "number") {
        result.push({
          type: PART_TYPE.literal,
          value: formatters.getNumberFormat(locales).format(currentPluralValue)
        });
      }
      continue;
    }
    const { value: varName } = el;
    if (!(values && varName in values)) {
      throw new MissingValueError(varName, originalMessage);
    }
    let value = values[varName];
    if (isArgumentElement(el)) {
      if (!value || typeof value === "string" || typeof value === "number") {
        value = typeof value === "string" || typeof value === "number" ? String(value) : "";
      }
      result.push({
        type: typeof value === "string" ? PART_TYPE.literal : PART_TYPE.object,
        value
      });
      continue;
    }
    if (isDateElement(el)) {
      const style = typeof el.style === "string" ? formats.date[el.style] : isDateTimeSkeleton(el.style) ? el.style.parsedOptions : void 0;
      result.push({
        type: PART_TYPE.literal,
        value: formatters.getDateTimeFormat(locales, style).format(value)
      });
      continue;
    }
    if (isTimeElement(el)) {
      const style = typeof el.style === "string" ? formats.time[el.style] : isDateTimeSkeleton(el.style) ? el.style.parsedOptions : void 0;
      result.push({
        type: PART_TYPE.literal,
        value: formatters.getDateTimeFormat(locales, style).format(value)
      });
      continue;
    }
    if (isNumberElement(el)) {
      const style = typeof el.style === "string" ? formats.number[el.style] : isNumberSkeleton(el.style) ? el.style.parsedOptions : void 0;
      if (style && style.scale) {
        value = value * (style.scale || 1);
      }
      result.push({
        type: PART_TYPE.literal,
        value: formatters.getNumberFormat(locales, style).format(value)
      });
      continue;
    }
    if (isTagElement(el)) {
      const { children, value: value2 } = el;
      const formatFn = values[value2];
      if (!isFormatXMLElementFn(formatFn)) {
        throw new InvalidValueTypeError(value2, "function", originalMessage);
      }
      const parts = formatToParts(children, locales, formatters, formats, values, currentPluralValue);
      let chunks = formatFn(parts.map((p) => p.value));
      if (!Array.isArray(chunks)) {
        chunks = [chunks];
      }
      result.push(...chunks.map((c) => {
        return {
          type: typeof c === "string" ? PART_TYPE.literal : PART_TYPE.object,
          value: c
        };
      }));
    }
    if (isSelectElement(el)) {
      const opt = el.options[value] || el.options.other;
      if (!opt) {
        throw new InvalidValueError(el.value, value, Object.keys(el.options), originalMessage);
      }
      result.push(...formatToParts(opt.value, locales, formatters, formats, values));
      continue;
    }
    if (isPluralElement(el)) {
      let opt = el.options[`=${value}`];
      if (!opt) {
        if (!Intl.PluralRules) {
          throw new FormatError(`Intl.PluralRules is not available in this environment.
Try polyfilling it using "@formatjs/intl-pluralrules"
`, ErrorCode.MISSING_INTL_API, originalMessage);
        }
        const rule = formatters.getPluralRules(locales, { type: el.pluralType }).select(value - (el.offset || 0));
        opt = el.options[rule] || el.options.other;
      }
      if (!opt) {
        throw new InvalidValueError(el.value, value, Object.keys(el.options), originalMessage);
      }
      result.push(...formatToParts(opt.value, locales, formatters, formats, values, value - (el.offset || 0)));
      continue;
    }
  }
  return mergeLiteral(result);
}
function mergeConfig(c1, c2) {
  if (!c2) {
    return c1;
  }
  return {
    ...c1 || {},
    ...c2 || {},
    ...Object.keys(c1).reduce((all, k) => {
      all[k] = {
        ...c1[k],
        ...c2[k] || {}
      };
      return all;
    }, {})
  };
}
function mergeConfigs(defaultConfig, configs) {
  if (!configs) {
    return defaultConfig;
  }
  return Object.keys(defaultConfig).reduce((all, k) => {
    all[k] = mergeConfig(defaultConfig[k], configs[k]);
    return all;
  }, { ...defaultConfig });
}
function createFastMemoizeCache(store) {
  return {
    create() {
      return {
        has(key) {
          return key in store;
        },
        get(key) {
          return store[key];
        },
        set(key, value) {
          store[key] = value;
        }
      };
    }
  };
}
function createDefaultFormatters(cache = {
  number: {},
  dateTime: {},
  pluralRules: {}
}) {
  return {
    getNumberFormat: memoize((...args) => new Intl.NumberFormat(...args), {
      cache: createFastMemoizeCache(cache.number),
      strategy: strategies.variadic
    }),
    getDateTimeFormat: memoize((...args) => new Intl.DateTimeFormat(...args), {
      cache: createFastMemoizeCache(cache.dateTime),
      strategy: strategies.variadic
    }),
    getPluralRules: memoize((...args) => new Intl.PluralRules(...args), {
      cache: createFastMemoizeCache(cache.pluralRules),
      strategy: strategies.variadic
    })
  };
}
var IntlMessageFormat = class {
  constructor(message, locales = IntlMessageFormat.defaultLocale, overrideFormats, opts) {
    this.formatterCache = {
      number: {},
      dateTime: {},
      pluralRules: {}
    };
    this.format = (values) => {
      const parts = this.formatToParts(values);
      if (parts.length === 1) {
        return parts[0].value;
      }
      const result = parts.reduce((all, part) => {
        if (!all.length || part.type !== PART_TYPE.literal || typeof all[all.length - 1] !== "string") {
          all.push(part.value);
        } else {
          all[all.length - 1] += part.value;
        }
        return all;
      }, []);
      if (result.length <= 1) {
        return result[0] || "";
      }
      return result;
    };
    this.formatToParts = (values) => formatToParts(this.ast, this.locales, this.formatters, this.formats, values, void 0, this.message);
    this.resolvedOptions = () => ({
      locale: Intl.NumberFormat.supportedLocalesOf(this.locales)[0]
    });
    this.getAst = () => this.ast;
    if (typeof message === "string") {
      this.message = message;
      if (!IntlMessageFormat.__parse) {
        throw new TypeError("IntlMessageFormat.__parse must be set to process `message` of type `string`");
      }
      this.ast = IntlMessageFormat.__parse(message, {
        ignoreTag: opts?.ignoreTag
      });
    } else {
      this.ast = message;
    }
    if (!Array.isArray(this.ast)) {
      throw new TypeError("A message must be provided as a String or AST.");
    }
    this.formats = mergeConfigs(IntlMessageFormat.formats, overrideFormats);
    this.locales = locales;
    this.formatters = opts && opts.formatters || createDefaultFormatters(this.formatterCache);
  }
  static get defaultLocale() {
    if (!IntlMessageFormat.memoizedDefaultLocale) {
      IntlMessageFormat.memoizedDefaultLocale = new Intl.NumberFormat().resolvedOptions().locale;
    }
    return IntlMessageFormat.memoizedDefaultLocale;
  }
};
IntlMessageFormat.memoizedDefaultLocale = null;
IntlMessageFormat.__parse = parse;
IntlMessageFormat.formats = {
  number: {
    integer: {
      maximumFractionDigits: 0
    },
    currency: {
      style: "currency"
    },
    percent: {
      style: "percent"
    }
  },
  date: {
    short: {
      month: "numeric",
      day: "numeric",
      year: "2-digit"
    },
    medium: {
      month: "short",
      day: "numeric",
      year: "numeric"
    },
    long: {
      month: "long",
      day: "numeric",
      year: "numeric"
    },
    full: {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    }
  },
  time: {
    short: {
      hour: "numeric",
      minute: "numeric"
    },
    medium: {
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    },
    long: {
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      timeZoneName: "short"
    },
    full: {
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      timeZoneName: "short"
    }
  }
};
var lib_esnext_default = IntlMessageFormat;

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/i18n/localized-string-set.ts
var EMPTY_VALUES_OBJECT = {};
var RegisteredFileStrings = class {
  constructor(filename, stringStructure, localizedMessages) {
    this.filename = filename;
    this.stringStructure = stringStructure;
    this.localizedMessages = localizedMessages;
  }
  filename;
  stringStructure;
  localizedMessages;
  localizedStringSet;
  getLocalizedStringSetFor(locale) {
    if (this.localizedStringSet) {
      return this.localizedStringSet;
    }
    const localeData = this.localizedMessages.get(locale);
    if (!localeData) {
      throw new Error(`No locale data registered for '${locale}'`);
    }
    this.localizedStringSet = new LocalizedStringSet(this.filename, this.stringStructure, locale, localeData);
    return this.localizedStringSet;
  }
};
var LocalizedStringSet = class {
  constructor(filename, stringStructure, locale, localizedMessages) {
    this.filename = filename;
    this.stringStructure = stringStructure;
    this.localizedMessages = localizedMessages;
    this.localeForFormatter = locale === "en-XA" || locale === "en-XL" ? "de-DE" : locale;
  }
  filename;
  stringStructure;
  localizedMessages;
  cachedSimpleStrings = /* @__PURE__ */ new Map();
  cachedMessageFormatters = /* @__PURE__ */ new Map();
  /** For pseudo locales, use 'de-DE' for number formatting */
  localeForFormatter;
  getLocalizedString(message, values = EMPTY_VALUES_OBJECT) {
    if (values === EMPTY_VALUES_OBJECT || Object.keys(values).length === 0) {
      return this.getSimpleLocalizedString(message);
    }
    return this.getFormattedLocalizedString(message, values);
  }
  getMessageFormatterFor(message) {
    const keyname = Object.keys(this.stringStructure).find((key) => this.stringStructure[key] === message);
    if (!keyname) {
      throw new Error(`Unable to locate '${message}' in UIStrings object`);
    }
    const i18nId = `${this.filename} | ${keyname}`;
    const localeMessage = this.localizedMessages[i18nId];
    const messageToTranslate = localeMessage ? localeMessage.message : message;
    return new lib_esnext_default(messageToTranslate, this.localeForFormatter, void 0, { ignoreTag: true });
  }
  getSimpleLocalizedString(message) {
    const cachedSimpleString = this.cachedSimpleStrings.get(message);
    if (cachedSimpleString) {
      return cachedSimpleString;
    }
    const formatter = this.getMessageFormatterFor(message);
    try {
      const translatedString = formatter.format();
      this.cachedSimpleStrings.set(message, translatedString);
      return translatedString;
    } catch {
      const formatter2 = new lib_esnext_default(message, this.localeForFormatter, void 0, { ignoreTag: true });
      const translatedString = formatter2.format();
      this.cachedSimpleStrings.set(message, translatedString);
      return translatedString;
    }
  }
  getFormattedLocalizedString(message, values) {
    let formatter = this.cachedMessageFormatters.get(message);
    if (!formatter) {
      formatter = this.getMessageFormatterFor(message);
      this.cachedMessageFormatters.set(message, formatter);
    }
    try {
      return formatter.format(values);
    } catch {
      const formatter2 = new lib_esnext_default(message, this.localeForFormatter, void 0, { ignoreTag: true });
      return formatter2.format(values);
    }
  }
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/i18n/i18n-impl.ts
var I18n = class {
  supportedLocales;
  localeData = /* @__PURE__ */ new Map();
  defaultLocale;
  constructor(supportedLocales, defaultLocale) {
    this.defaultLocale = defaultLocale;
    this.supportedLocales = new Set(supportedLocales);
  }
  registerLocaleData(locale, messages) {
    this.localeData.set(locale, messages);
  }
  hasLocaleDataForTest(locale) {
    return this.localeData.has(locale);
  }
  resetLocaleDataForTest() {
    this.localeData.clear();
  }
  registerFileStrings(filename, stringStructure) {
    return new RegisteredFileStrings(filename, stringStructure, this.localeData);
  }
  /**
   * Look up the best available locale for the requested language through these fall backs:
   * - exact match
   * - progressively shorter prefixes (`de-CH-1996` -> `de-CH` -> `de`)
   * - the default locale if no match is found
   */
  lookupClosestSupportedLocale(locale) {
    const canonicalLocale = Intl.getCanonicalLocales(locale)[0];
    const localeParts = canonicalLocale.split("-");
    while (localeParts.length) {
      const candidate = localeParts.join("-");
      if (this.supportedLocales.has(candidate)) {
        return candidate;
      }
      localeParts.pop();
    }
    return this.defaultLocale;
  }
};

// upstream-mock:locales
var LOCALES = [
  "en-US"
];
var BUNDLED_LOCALES = [
  "en-US"
];
var DEFAULT_LOCALE = "en-US";
var REMOTE_FETCH_PATTERN = "@HOST@/remote/serve_file/@VERSION@/core/i18n/locales/@LOCALE@.json";
var LOCAL_FETCH_PATTERN = "./locales/@LOCALE@.json";

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/i18nImpl.ts
var i18nInstance = new i18n_impl_exports.I18n(LOCALES, DEFAULT_LOCALE);
var BUNDLED_LOCALES2 = /* @__PURE__ */ new Set([...BUNDLED_LOCALES]);
function lookupClosestSupportedDevToolsLocale(locale) {
  return i18nInstance.lookupClosestSupportedLocale(locale);
}
function getAllSupportedDevToolsLocales() {
  return [...i18nInstance.supportedLocales];
}
function getLocaleFetchUrl(locale, location) {
  const remoteBase = runtime_exports.getRemoteBase(location);
  if (remoteBase?.version && !BUNDLED_LOCALES2.has(locale)) {
    return REMOTE_FETCH_PATTERN.replace("@HOST@", "devtools://devtools").replace("@VERSION@", remoteBase.version).replace("@LOCALE@", locale);
  }
  const path = LOCAL_FETCH_PATTERN.replace("@LOCALE@", locale);
  return new URL(path, import.meta.url).toString();
}
async function fetchAndRegisterLocaleData(locale, location = globalThis.location?.toString() ?? "") {
  const localeDataTextPromise = fetch(getLocaleFetchUrl(locale, location)).then((result) => result.json());
  const timeoutPromise = new Promise(
    (_, reject) => globalThis.setTimeout(() => reject(new Error("timed out fetching locale")), 5e3)
  );
  const localeData = await Promise.race([timeoutPromise, localeDataTextPromise]);
  i18nInstance.registerLocaleData(locale, localeData);
}
function hasLocaleDataForTest(locale) {
  return i18nInstance.hasLocaleDataForTest(locale);
}
function resetLocaleDataForTest() {
  i18nInstance.resetLocaleDataForTest();
}
function registerLocaleDataForTest(locale, messages) {
  i18nInstance.registerLocaleData(locale, messages);
}
function getLazilyComputedLocalizedString(registeredStrings, id, values = {}) {
  return () => getLocalizedString(registeredStrings, id, values);
}
function getLocalizedString(registeredStrings, id, values = {}) {
  return registeredStrings.getLocalizedStringSetFor(DevToolsLocale.instance().locale).getLocalizedString(id, values);
}
function registerUIStrings(path, stringStructure) {
  return i18nInstance.registerFileStrings(path, stringStructure);
}
function serializeUIString(string, values = {}) {
  const serializedMessage = { string, values };
  return JSON.stringify(serializedMessage);
}
function deserializeUIString(serializedMessage) {
  if (!serializedMessage) {
    return { string: "", values: {} };
  }
  return JSON.parse(serializedMessage);
}
function lockedString(str) {
  return str;
}
function lockedLazyString(str) {
  return () => str;
}
function getLocalizedLanguageRegion(localeString, devtoolsLocale) {
  const locale = new Intl.Locale(localeString);
  const { language, baseName } = locale;
  const devtoolsLoc = new Intl.Locale(devtoolsLocale.locale);
  const targetLanguage = language === devtoolsLoc.language ? "en" : baseName;
  const languageInCurrentLocale = new Intl.DisplayNames([devtoolsLocale.locale], { type: "language" }).of(language);
  const languageInTargetLocale = new Intl.DisplayNames([targetLanguage], { type: "language" }).of(language);
  let wrappedRegionInCurrentLocale = "";
  let wrappedRegionInTargetLocale = "";
  if (locale.region) {
    const regionInCurrentLocale = new Intl.DisplayNames([devtoolsLocale.locale], { type: "region", style: "short" }).of(locale.region);
    const regionInTargetLocale = new Intl.DisplayNames([targetLanguage], { type: "region", style: "short" }).of(locale.region);
    wrappedRegionInCurrentLocale = ` (${regionInCurrentLocale})`;
    wrappedRegionInTargetLocale = ` (${regionInTargetLocale})`;
  }
  return `${languageInCurrentLocale}${wrappedRegionInCurrentLocale} - ${languageInTargetLocale}${wrappedRegionInTargetLocale}`;
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/i18n/time-utilities.ts
var narrowMillisecondsInteger = defineFormatter({
  style: "unit",
  unit: "millisecond",
  unitDisplay: "narrow",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
var longMilliseconds = defineFormatter({
  style: "unit",
  unit: "millisecond",
  unitDisplay: "long",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
var narrowMicrosecondsInteger = defineFormatter({
  style: "unit",
  unit: "microsecond",
  unitDisplay: "narrow",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
var narrowMillisecondsDecimal = defineFormatter({
  style: "unit",
  unit: "millisecond",
  unitDisplay: "narrow",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
var narrowSecondsDecimal = defineFormatter({
  style: "unit",
  unit: "second",
  unitDisplay: "narrow",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
var shortMinutesDecimal = defineFormatter({
  style: "unit",
  unit: "minute",
  unitDisplay: "short",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1
});
var shortHoursDecimal = defineFormatter({
  style: "unit",
  unit: "hour",
  unitDisplay: "short",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1
});
var longDaysDecimal = defineFormatter({
  style: "unit",
  unit: "day",
  unitDisplay: "long",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/Revealer.ts
var UIStrings = {
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  elementsPanel: "Elements panel",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  stylesSidebar: "Styles sidebar",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  changesDrawer: "Changes drawer",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  issuesView: "Issues view",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  networkPanel: "Network panel",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  requestConditionsDrawer: "Request conditions drawer",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  applicationPanel: "Application panel",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  sourcesPanel: "Sources panel",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  timelinePanel: "Performance panel",
  /**
   * @description The UI destination when right-clicking an item that can be revealed.
   */
  memoryInspectorPanel: "Memory inspector panel",
  /**
   * @description The UI destination when revealing loaded resources through the Developer resources panel.
   */
  developerResourcesPanel: "Developer resources panel",
  /**
   * @description The UI destination when revealing loaded resources through the Animations panel.
   */
  animationsPanel: "Animations panel",
  /**
   * @description The UI destination when revealing an item in the Lighthouse panel.
   */
  lighthousePanel: "Lighthouse panel"
};
var str_ = i18nImpl_exports.registerUIStrings("core/common/Revealer.ts", UIStrings);
var i18nLazyString = i18nImpl_exports.getLazilyComputedLocalizedString.bind(void 0, str_);
var RevealerDestination = {
  DEVELOPER_RESOURCES_PANEL: i18nLazyString(UIStrings.developerResourcesPanel),
  ELEMENTS_PANEL: i18nLazyString(UIStrings.elementsPanel),
  STYLES_SIDEBAR: i18nLazyString(UIStrings.stylesSidebar),
  CHANGES_DRAWER: i18nLazyString(UIStrings.changesDrawer),
  ISSUES_VIEW: i18nLazyString(UIStrings.issuesView),
  NETWORK_PANEL: i18nLazyString(UIStrings.networkPanel),
  REQUEST_CONDITIONS_DRAWER: i18nLazyString(UIStrings.requestConditionsDrawer),
  TIMELINE_PANEL: i18nLazyString(UIStrings.timelinePanel),
  APPLICATION_PANEL: i18nLazyString(UIStrings.applicationPanel),
  SOURCES_PANEL: i18nLazyString(UIStrings.sourcesPanel),
  MEMORY_INSPECTOR_PANEL: i18nLazyString(UIStrings.memoryInspectorPanel),
  ANIMATIONS_PANEL: i18nLazyString(UIStrings.animationsPanel),
  LIGHTHOUSE_PANEL: i18nLazyString(UIStrings.lighthousePanel)
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/ParsedURL.ts
function normalizePath(path) {
  if (path.indexOf("..") === -1 && path.indexOf(".") === -1) {
    return path;
  }
  const segments = (path[0] === "/" ? path.substring(1) : path).split("/");
  const normalizedSegments = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    } else if (segment === "..") {
      normalizedSegments.pop();
    } else {
      normalizedSegments.push(segment);
    }
  }
  let normalizedPath = normalizedSegments.join("/");
  if (path[0] === "/" && normalizedPath) {
    normalizedPath = "/" + normalizedPath;
  }
  if (normalizedPath[normalizedPath.length - 1] !== "/" && (path[path.length - 1] === "/" || segments[segments.length - 1] === "." || segments[segments.length - 1] === "..")) {
    normalizedPath = normalizedPath + "/";
  }
  return normalizedPath;
}
var ParsedURL = class _ParsedURL {
  isValid = false;
  url;
  scheme = "";
  user = "";
  host = "";
  port = "";
  path = "";
  queryParams = "";
  fragment = "";
  folderPathComponents = "";
  lastPathComponent = "";
  blobInnerScheme;
  #displayName;
  #dataURLDisplayName;
  constructor(url) {
    this.url = url;
    const isBlobUrl = this.url.startsWith("blob:");
    const urlToMatch = isBlobUrl ? url.substring(5) : url;
    const match = urlToMatch.match(_ParsedURL.urlRegex());
    if (match) {
      this.isValid = true;
      if (isBlobUrl) {
        this.blobInnerScheme = match[2].toLowerCase();
        this.scheme = "blob";
      } else {
        this.scheme = match[2].toLowerCase();
      }
      this.user = match[3] ?? "";
      this.host = match[4] ?? "";
      this.port = match[5] ?? "";
      this.path = match[6] ?? "/";
      this.queryParams = match[7] ?? "";
      this.fragment = match[8] ?? "";
    } else {
      if (this.url.startsWith("data:")) {
        this.scheme = "data";
        return;
      }
      if (this.url.startsWith("blob:")) {
        this.scheme = "blob";
        return;
      }
      if (this.url === "about:blank") {
        this.scheme = "about";
        return;
      }
      this.path = this.url;
    }
    const lastSlashExceptTrailingIndex = this.path.lastIndexOf("/", this.path.length - 2);
    if (lastSlashExceptTrailingIndex !== -1) {
      this.lastPathComponent = this.path.substring(lastSlashExceptTrailingIndex + 1);
    } else {
      this.lastPathComponent = this.path;
    }
    const lastSlashIndex = this.path.lastIndexOf("/");
    if (lastSlashIndex !== -1) {
      this.folderPathComponents = this.path.substring(0, lastSlashIndex);
    }
  }
  static fromString(string) {
    const parsedURL = new _ParsedURL(string.toString());
    if (parsedURL.isValid) {
      return parsedURL;
    }
    return null;
  }
  static preEncodeSpecialCharactersInPath(path) {
    for (const specialChar of ["%", ";", "#", "?", " "]) {
      path = path.replaceAll(specialChar, encodeURIComponent(specialChar));
    }
    return path;
  }
  static rawPathToEncodedPathString(path) {
    const partiallyEncoded = _ParsedURL.preEncodeSpecialCharactersInPath(path);
    if (path.startsWith("/")) {
      return new URL(partiallyEncoded, "file:///").pathname;
    }
    return new URL("/" + partiallyEncoded, "file:///").pathname.substr(1);
  }
  /**
   * @param name Must not be encoded
   */
  static encodedFromParentPathAndName(parentPath, name) {
    return _ParsedURL.concatenate(parentPath, "/", _ParsedURL.preEncodeSpecialCharactersInPath(name));
  }
  /**
   * @param name Must not be encoded
   */
  static urlFromParentUrlAndName(parentUrl, name) {
    return _ParsedURL.concatenate(parentUrl, "/", _ParsedURL.preEncodeSpecialCharactersInPath(name));
  }
  static encodedPathToRawPathString(encPath) {
    return decodeURIComponent(encPath);
  }
  static rawPathToUrlString(fileSystemPath) {
    let preEncodedPath = _ParsedURL.preEncodeSpecialCharactersInPath(
      fileSystemPath.replace(/\\/g, "/")
    );
    preEncodedPath = preEncodedPath.replace(/\\/g, "/");
    if (!preEncodedPath.startsWith("file://")) {
      if (preEncodedPath.startsWith("/")) {
        preEncodedPath = "file://" + preEncodedPath;
      } else {
        preEncodedPath = "file:///" + preEncodedPath;
      }
    }
    return new URL(preEncodedPath).toString();
  }
  static relativePathToUrlString(relativePath, baseURL) {
    const preEncodedPath = _ParsedURL.preEncodeSpecialCharactersInPath(
      relativePath.replace(/\\/g, "/")
    );
    return new URL(preEncodedPath, baseURL).toString();
  }
  static urlToRawPathString(fileURL, isWindows) {
    console.assert(fileURL.startsWith("file://"), "This must be a file URL.");
    const decodedFileURL = decodeURIComponent(fileURL);
    if (isWindows) {
      return decodedFileURL.substr("file:///".length).replace(/\//g, "\\");
    }
    return decodedFileURL.substr("file://".length);
  }
  static sliceUrlToEncodedPathString(url, start) {
    return url.substring(start);
  }
  static substr(devToolsPath, from, length) {
    return devToolsPath.substr(from, length);
  }
  static substring(devToolsPath, start, end) {
    return devToolsPath.substring(start, end);
  }
  static prepend(prefix, devToolsPath) {
    return prefix + devToolsPath;
  }
  static concatenate(devToolsPath, ...appendage) {
    return devToolsPath.concat(...appendage);
  }
  static trim(devToolsPath) {
    return devToolsPath.trim();
  }
  static slice(devToolsPath, start, end) {
    return devToolsPath.slice(start, end);
  }
  static join(devToolsPaths, separator) {
    return devToolsPaths.join(separator);
  }
  static split(devToolsPath, separator, limit) {
    return devToolsPath.split(separator, limit);
  }
  static toLowerCase(devToolsPath) {
    return devToolsPath.toLowerCase();
  }
  static isValidUrlString(str) {
    return new _ParsedURL(str).isValid;
  }
  static urlWithoutHash(url) {
    const hashIndex = url.indexOf("#");
    if (hashIndex !== -1) {
      return url.substr(0, hashIndex);
    }
    return url;
  }
  static urlRegex() {
    if (_ParsedURL.urlRegexInstance) {
      return _ParsedURL.urlRegexInstance;
    }
    const schemeRegex = /([A-Za-z][A-Za-z0-9+.-]*):\/\//;
    const userRegex = /(?:([A-Za-z0-9\-._~%!$&'()*+,;=:]*)@)?/;
    const hostRegex = /((?:\[::\d?\])|(?:[^\s\/:]*))/;
    const portRegex = /(?::([\d]+))?/;
    const pathRegex = /(\/[^#?]*)?/;
    const queryRegex = /(?:\?([^#]*))?/;
    const fragmentRegex = /(?:#(.*))?/;
    _ParsedURL.urlRegexInstance = new RegExp(
      "^(" + schemeRegex.source + userRegex.source + hostRegex.source + portRegex.source + ")" + pathRegex.source + queryRegex.source + fragmentRegex.source + "$"
    );
    return _ParsedURL.urlRegexInstance;
  }
  static extractPath(url) {
    const parsedURL = this.fromString(url);
    return parsedURL ? parsedURL.path : "";
  }
  static extractOrigin(url) {
    const parsedURL = this.fromString(url);
    return parsedURL ? parsedURL.securityOrigin() : DevToolsPath_exports.EmptyUrlString;
  }
  static extractExtension(url) {
    url = _ParsedURL.urlWithoutHash(url);
    const indexOfQuestionMark = url.indexOf("?");
    if (indexOfQuestionMark !== -1) {
      url = url.substr(0, indexOfQuestionMark);
    }
    const lastIndexOfSlash = url.lastIndexOf("/");
    if (lastIndexOfSlash !== -1) {
      url = url.substr(lastIndexOfSlash + 1);
    }
    const lastIndexOfDot = url.lastIndexOf(".");
    if (lastIndexOfDot !== -1) {
      url = url.substr(lastIndexOfDot + 1);
      const lastIndexOfPercent = url.indexOf("%");
      if (lastIndexOfPercent !== -1) {
        return url.substr(0, lastIndexOfPercent);
      }
      return url;
    }
    return "";
  }
  static extractName(url) {
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    let index = url.lastIndexOf("/");
    const pathAndQuery = index !== -1 ? url.substr(index + 1) : url;
    index = pathAndQuery.indexOf("?");
    return index < 0 ? pathAndQuery : pathAndQuery.substr(0, index);
  }
  static completeURL(baseURL, href) {
    if (href.startsWith("data:") || href.startsWith("blob:") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      return href;
    }
    const trimmedHref = href.trim();
    const parsedHref = this.fromString(trimmedHref);
    if (parsedHref?.scheme) {
      const securityOrigin2 = parsedHref.securityOrigin();
      const pathText2 = normalizePath(parsedHref.path);
      const queryText2 = parsedHref.queryParams && `?${parsedHref.queryParams}`;
      const fragmentText = parsedHref.fragment && `#${parsedHref.fragment}`;
      return securityOrigin2 + pathText2 + queryText2 + fragmentText;
    }
    const parsedURL = this.fromString(baseURL);
    if (!parsedURL) {
      return null;
    }
    if (parsedURL.isDataURL()) {
      return href;
    }
    if (href.length > 1 && href.charAt(0) === "/" && href.charAt(1) === "/") {
      return parsedURL.scheme + ":" + href;
    }
    const securityOrigin = parsedURL.securityOrigin();
    const pathText = parsedURL.path;
    const queryText = parsedURL.queryParams ? "?" + parsedURL.queryParams : "";
    if (!href.length) {
      return securityOrigin + pathText + queryText;
    }
    if (href.charAt(0) === "#") {
      return securityOrigin + pathText + queryText + href;
    }
    if (href.charAt(0) === "?") {
      return securityOrigin + pathText + href;
    }
    const hrefMatches = href.match(/^[^#?]*/);
    if (!hrefMatches || !href.length) {
      throw new Error("Invalid href");
    }
    let hrefPath = hrefMatches[0];
    const hrefSuffix = href.substring(hrefPath.length);
    if (hrefPath.charAt(0) !== "/") {
      hrefPath = parsedURL.folderPathComponents + "/" + hrefPath;
    }
    return securityOrigin + normalizePath(hrefPath) + hrefSuffix;
  }
  static splitLineAndColumn(string) {
    const beforePathMatch = string.match(_ParsedURL.urlRegex());
    let beforePath = "";
    let pathAndAfter = string;
    if (beforePathMatch) {
      beforePath = beforePathMatch[1];
      pathAndAfter = string.substring(beforePathMatch[1].length);
    }
    const lineColumnRegEx = /(?::(\d+))?(?::(\d+))?$/;
    const lineColumnMatch = lineColumnRegEx.exec(pathAndAfter);
    let lineNumber;
    let columnNumber;
    console.assert(Boolean(lineColumnMatch));
    if (!lineColumnMatch) {
      return { url: string, lineNumber: 0, columnNumber: 0 };
    }
    if (typeof lineColumnMatch[1] === "string") {
      lineNumber = parseInt(lineColumnMatch[1], 10);
      lineNumber = isNaN(lineNumber) ? void 0 : lineNumber - 1;
    }
    if (typeof lineColumnMatch[2] === "string") {
      columnNumber = parseInt(lineColumnMatch[2], 10);
      columnNumber = isNaN(columnNumber) ? void 0 : columnNumber - 1;
    }
    let url = beforePath + pathAndAfter.substring(0, pathAndAfter.length - lineColumnMatch[0].length);
    if (lineColumnMatch[1] === void 0 && lineColumnMatch[2] === void 0) {
      const wasmCodeOffsetRegex = /wasm-function\[\d+\]:0x([a-z0-9]+)$/g;
      const wasmCodeOffsetMatch = wasmCodeOffsetRegex.exec(pathAndAfter);
      if (wasmCodeOffsetMatch && typeof wasmCodeOffsetMatch[1] === "string") {
        url = _ParsedURL.removeWasmFunctionInfoFromURL(url);
        columnNumber = parseInt(wasmCodeOffsetMatch[1], 16);
        columnNumber = isNaN(columnNumber) ? void 0 : columnNumber;
      }
    }
    return { url, lineNumber, columnNumber };
  }
  static removeWasmFunctionInfoFromURL(url) {
    const wasmFunctionRegEx = /:wasm-function\[\d+\]/;
    const wasmFunctionIndex = url.search(wasmFunctionRegEx);
    if (wasmFunctionIndex === -1) {
      return url;
    }
    return _ParsedURL.substring(url, 0, wasmFunctionIndex);
  }
  static beginsWithWindowsDriveLetter(url) {
    return /^[A-Za-z]:/.test(url);
  }
  static beginsWithScheme(url) {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url);
  }
  static isRelativeURL(url) {
    return !this.beginsWithScheme(url) || this.beginsWithWindowsDriveLetter(url);
  }
  get displayName() {
    if (this.#displayName) {
      return this.#displayName;
    }
    if (this.isDataURL()) {
      return this.dataURLDisplayName();
    }
    if (this.isBlobURL()) {
      return this.url;
    }
    if (this.isAboutBlank()) {
      return this.url;
    }
    this.#displayName = this.lastPathComponent;
    if (!this.#displayName) {
      this.#displayName = (this.host || "") + "/";
    }
    if (this.#displayName === "/") {
      this.#displayName = this.url;
    }
    return this.#displayName;
  }
  dataURLDisplayName() {
    if (this.#dataURLDisplayName) {
      return this.#dataURLDisplayName;
    }
    if (!this.isDataURL()) {
      return "";
    }
    this.#dataURLDisplayName = StringUtilities_exports.trimEndWithMaxLength(this.url, 20);
    return this.#dataURLDisplayName;
  }
  isAboutBlank() {
    return this.url === "about:blank";
  }
  isDataURL() {
    return this.scheme === "data";
  }
  extractDataUrlMimeType() {
    const regexp = /^data:((?<type>\w+)\/(?<subtype>\w+))?(;base64)?,/;
    const match = this.url.match(regexp);
    return {
      type: match?.groups?.type,
      subtype: match?.groups?.subtype
    };
  }
  isBlobURL() {
    return this.url.startsWith("blob:");
  }
  lastPathComponentWithFragment() {
    return this.lastPathComponent + (this.fragment ? "#" + this.fragment : "");
  }
  domain() {
    if (this.isDataURL()) {
      return "data:";
    }
    return this.host + (this.port ? ":" + this.port : "");
  }
  securityOrigin() {
    if (this.isDataURL()) {
      return "data:";
    }
    const scheme = this.isBlobURL() ? this.blobInnerScheme : this.scheme;
    const domain = this.domain();
    if (!scheme && !domain) {
      return "";
    }
    return scheme + "://" + domain;
  }
  urlWithoutScheme() {
    if (this.scheme && this.url.startsWith(this.scheme + "://")) {
      return this.url.substring(this.scheme.length + 3);
    }
    return this.url;
  }
  static urlRegexInstance = null;
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/ResourceType.ts
var UIStrings2 = {
  /**
   * @description Text that appears in a tooltip for the Fetch and XHR resource types filter.
   */
  fetchAndXHR: "`Fetch` and `XHR`",
  /**
   * @description Text that appears in a tooltip for the JavaScript types filter.
   */
  javascript: "JavaScript",
  /**
   * @description Text that appears on a button for the JavaScript resource type filter.
   */
  js: "JS",
  /**
   * @description Text that appears on a button for the CSS resource type filter.
   */
  css: "CSS",
  /**
   * @description Text that appears on a button for the image resource type filter.
   */
  img: "Img",
  /**
   * @description Text that appears on a button for the media resource type filter.
   */
  media: "Media",
  /**
   * @description Text that appears on a button for the font resource type filter.
   */
  font: "Font",
  /**
   * @description Text that appears on a button for the document resource type filter.
   */
  doc: "Doc",
  /**
   * @description Text that appears on a button for the WebSocket, WebTransport, and DirectSocket resource type filter.
   */
  socketShort: "Socket",
  /**
   * @description Text that appears in a tooltip for the WebAssembly types filter.
   */
  webassembly: "WebAssembly",
  /**
   * @description Text that appears on a button for the WebAssembly resource type filter.
   */
  wasm: "Wasm",
  /**
   * @description Text that appears on a button for the manifest resource type filter.
   */
  manifest: "Manifest",
  /**
   * @description Text for other types of items.
   */
  other: "Other",
  /**
   * @description Name of a network resource type.
   */
  document: "Document",
  /**
   * @description Name of a network resource type.
   */
  stylesheet: "Stylesheet",
  /**
   * @description Text in Image view of the Sources panel.
   */
  image: "Image",
  /**
   * @description Label for a group of JavaScript files.
   */
  script: "Script",
  /**
   * @description Name of a network resource type.
   */
  texttrack: "TextTrack",
  /**
   * @description Name of a network resource type.
   */
  fetch: "Fetch",
  /**
   * @description Name of a network resource type.
   */
  eventsource: "EventSource",
  /**
   * @description Name of a network resource type.
   */
  websocket: "WebSocket",
  /**
   * @description Name of a network resource type.
   */
  webtransport: "WebTransport",
  /**
   * @description Name of a network resource type.
   */
  directsocket: "DirectSocket",
  /**
   * @description Name of a network resource type.
   */
  signedexchange: "SignedExchange",
  /**
   * @description Name of a network resource type.
   */
  ping: "Ping",
  /**
   * @description Name of a network resource type.
   */
  cspviolationreport: "CSPViolationReport",
  /**
   * @description Name of a network initiator type.
   */
  preflight: "Preflight",
  /**
   * @description Name of a network initiator type for FedCM requests.
   */
  fedcm: "FedCM"
};
var str_2 = i18nImpl_exports.registerUIStrings("core/common/ResourceType.ts", UIStrings2);
var i18nLazyString2 = i18nImpl_exports.getLazilyComputedLocalizedString.bind(void 0, str_2);
var ResourceType = class {
  #name;
  #title;
  #category;
  #isTextType;
  constructor(name, title, category, isTextType) {
    this.#name = name;
    this.#title = title;
    this.#category = category;
    this.#isTextType = isTextType;
  }
  static fromMimeType(mimeType) {
    if (!mimeType) {
      return resourceTypes.Other;
    }
    if (mimeType.startsWith("text/html")) {
      return resourceTypes.Document;
    }
    if (mimeType.startsWith("text/css")) {
      return resourceTypes.Stylesheet;
    }
    if (mimeType.startsWith("image/")) {
      return resourceTypes.Image;
    }
    if (mimeType.startsWith("text/")) {
      return resourceTypes.Script;
    }
    if (mimeType.includes("font")) {
      return resourceTypes.Font;
    }
    if (mimeType.includes("script")) {
      return resourceTypes.Script;
    }
    if (mimeType.includes("octet")) {
      return resourceTypes.Other;
    }
    if (mimeType.includes("application")) {
      return resourceTypes.Script;
    }
    return resourceTypes.Other;
  }
  static fromMimeTypeOverride(mimeType) {
    if (mimeType === "application/manifest+json") {
      return resourceTypes.Manifest;
    }
    if (mimeType === "application/wasm") {
      return resourceTypes.Wasm;
    }
    return null;
  }
  static fromURL(url) {
    return resourceTypeByExtension.get(ParsedURL.extractExtension(url)) || null;
  }
  static fromName(name) {
    for (const resourceType of Object.values(resourceTypes)) {
      if (resourceType.name() === name) {
        return resourceType;
      }
    }
    return null;
  }
  static mimeFromURL(url) {
    if (url.startsWith("snippet://") || url.startsWith("debugger://")) {
      return "text/javascript";
    }
    const name = ParsedURL.extractName(url);
    if (mimeTypeByName.has(name)) {
      return mimeTypeByName.get(name);
    }
    let ext = ParsedURL.extractExtension(url).toLowerCase();
    if (ext === "html" && name.endsWith(".component.html")) {
      ext = "component.html";
    }
    return mimeTypeByExtension.get(ext);
  }
  static mimeFromExtension(ext) {
    return mimeTypeByExtension.get(ext);
  }
  static simplifyContentType(contentType) {
    const regex = new RegExp("^application(.*json$|/json+.*)");
    return regex.test(contentType) ? "application/json" : contentType;
  }
  /**
   * Checks whether the given MIME type represents JavaScript content.
   */
  static isJavaScriptMimeType(mimeType) {
    return mimeType === "application/javascript" || mimeType === "text/javascript";
  }
  /**
   * Adds suffixes iff the mimeType is 'text/javascript' to denote whether the JS is minified or from
   * a source map.
   */
  static mediaTypeForMetrics(mimeType, isFromSourceMap, isMinified, isSnippet, isDebugger) {
    if (mimeType !== "text/javascript") {
      return mimeType;
    }
    if (isFromSourceMap) {
      return "text/javascript+sourcemapped";
    }
    if (isMinified) {
      return "text/javascript+minified";
    }
    if (isSnippet) {
      return "text/javascript+snippet";
    }
    if (isDebugger) {
      return "text/javascript+eval";
    }
    return "text/javascript+plain";
  }
  name() {
    return this.#name;
  }
  title() {
    return this.#title();
  }
  category() {
    return this.#category;
  }
  isTextType() {
    return this.#isTextType;
  }
  isScript() {
    return this.#name === "script" || this.#name === "sm-script";
  }
  hasScripts() {
    return this.isScript() || this.isDocument();
  }
  isStyleSheet() {
    return this.#name === "stylesheet" || this.#name === "sm-stylesheet";
  }
  hasStyleSheets() {
    return this.isStyleSheet() || this.isDocument();
  }
  isDocument() {
    return this.#name === "document";
  }
  isDocumentOrScriptOrStyleSheet() {
    return this.isDocument() || this.isScript() || this.isStyleSheet();
  }
  isFont() {
    return this.#name === "font";
  }
  isImage() {
    return this.#name === "image";
  }
  isFromSourceMap() {
    return this.#name.startsWith("sm-");
  }
  toString() {
    return this.#name;
  }
  canonicalMimeType() {
    if (this.isDocument()) {
      return "text/html";
    }
    if (this.isScript()) {
      return "text/javascript";
    }
    if (this.isStyleSheet()) {
      return "text/css";
    }
    return "";
  }
};
var ResourceCategory = class {
  name;
  title;
  shortTitle;
  constructor(name, title, shortTitle) {
    this.name = name;
    this.title = title;
    this.shortTitle = shortTitle;
  }
};
var resourceCategories = {
  XHR: new ResourceCategory(
    "Fetch and XHR",
    i18nLazyString2(UIStrings2.fetchAndXHR),
    i18nImpl_exports.lockedLazyString("Fetch/XHR")
  ),
  Document: new ResourceCategory(UIStrings2.document, i18nLazyString2(UIStrings2.document), i18nLazyString2(UIStrings2.doc)),
  Stylesheet: new ResourceCategory(UIStrings2.css, i18nLazyString2(UIStrings2.css), i18nLazyString2(UIStrings2.css)),
  Script: new ResourceCategory(UIStrings2.javascript, i18nLazyString2(UIStrings2.javascript), i18nLazyString2(UIStrings2.js)),
  Font: new ResourceCategory(UIStrings2.font, i18nLazyString2(UIStrings2.font), i18nLazyString2(UIStrings2.font)),
  Image: new ResourceCategory(UIStrings2.image, i18nLazyString2(UIStrings2.image), i18nLazyString2(UIStrings2.img)),
  Media: new ResourceCategory(UIStrings2.media, i18nLazyString2(UIStrings2.media), i18nLazyString2(UIStrings2.media)),
  Manifest: new ResourceCategory(UIStrings2.manifest, i18nLazyString2(UIStrings2.manifest), i18nLazyString2(UIStrings2.manifest)),
  Socket: new ResourceCategory(
    "Socket",
    i18nImpl_exports.lockedLazyString("WebSocket | WebTransport | DirectSocket"),
    i18nLazyString2(UIStrings2.socketShort)
  ),
  Wasm: new ResourceCategory(
    UIStrings2.webassembly,
    i18nLazyString2(UIStrings2.webassembly),
    i18nLazyString2(UIStrings2.wasm)
  ),
  Other: new ResourceCategory(UIStrings2.other, i18nLazyString2(UIStrings2.other), i18nLazyString2(UIStrings2.other))
};
var resourceTypes = {
  Document: new ResourceType("document", i18nLazyString2(UIStrings2.document), resourceCategories.Document, true),
  Stylesheet: new ResourceType("stylesheet", i18nLazyString2(UIStrings2.stylesheet), resourceCategories.Stylesheet, true),
  Image: new ResourceType("image", i18nLazyString2(UIStrings2.image), resourceCategories.Image, false),
  Media: new ResourceType("media", i18nLazyString2(UIStrings2.media), resourceCategories.Media, false),
  Font: new ResourceType("font", i18nLazyString2(UIStrings2.font), resourceCategories.Font, false),
  Script: new ResourceType("script", i18nLazyString2(UIStrings2.script), resourceCategories.Script, true),
  TextTrack: new ResourceType("texttrack", i18nLazyString2(UIStrings2.texttrack), resourceCategories.Other, true),
  XHR: new ResourceType("xhr", i18nImpl_exports.lockedLazyString("XHR"), resourceCategories.XHR, true),
  Fetch: new ResourceType("fetch", i18nLazyString2(UIStrings2.fetch), resourceCategories.XHR, true),
  Prefetch: new ResourceType("prefetch", i18nImpl_exports.lockedLazyString("Prefetch"), resourceCategories.Document, true),
  EventSource: new ResourceType("eventsource", i18nLazyString2(UIStrings2.eventsource), resourceCategories.XHR, true),
  WebSocket: new ResourceType("websocket", i18nLazyString2(UIStrings2.websocket), resourceCategories.Socket, false),
  WebTransport: new ResourceType("webtransport", i18nLazyString2(UIStrings2.webtransport), resourceCategories.Socket, false),
  DirectSocket: new ResourceType("directsocket", i18nLazyString2(UIStrings2.directsocket), resourceCategories.Socket, false),
  Wasm: new ResourceType("wasm", i18nLazyString2(UIStrings2.wasm), resourceCategories.Wasm, false),
  Manifest: new ResourceType("manifest", i18nLazyString2(UIStrings2.manifest), resourceCategories.Manifest, true),
  SignedExchange: new ResourceType("signed-exchange", i18nLazyString2(UIStrings2.signedexchange), resourceCategories.Other, false),
  Ping: new ResourceType("ping", i18nLazyString2(UIStrings2.ping), resourceCategories.Other, false),
  CSPViolationReport: new ResourceType(
    "csp-violation-report",
    i18nLazyString2(UIStrings2.cspviolationreport),
    resourceCategories.Other,
    false
  ),
  Other: new ResourceType("other", i18nLazyString2(UIStrings2.other), resourceCategories.Other, false),
  Preflight: new ResourceType("preflight", i18nLazyString2(UIStrings2.preflight), resourceCategories.Other, true),
  SourceMapScript: new ResourceType("sm-script", i18nLazyString2(UIStrings2.script), resourceCategories.Script, true),
  SourceMapStyleSheet: new ResourceType("sm-stylesheet", i18nLazyString2(UIStrings2.stylesheet), resourceCategories.Stylesheet, true),
  FedCM: new ResourceType("fedcm", i18nLazyString2(UIStrings2.fedcm), resourceCategories.Other, false)
};
var mimeTypeByName = /* @__PURE__ */ new Map([
  // CoffeeScript
  ["Cakefile", "text/x-coffeescript"]
]);
var resourceTypeByExtension = /* @__PURE__ */ new Map([
  ["js", resourceTypes.Script],
  ["mjs", resourceTypes.Script],
  ["css", resourceTypes.Stylesheet],
  ["xsl", resourceTypes.Stylesheet],
  ["avif", resourceTypes.Image],
  ["bmp", resourceTypes.Image],
  ["gif", resourceTypes.Image],
  ["ico", resourceTypes.Image],
  ["jpeg", resourceTypes.Image],
  ["jpg", resourceTypes.Image],
  ["jxl", resourceTypes.Image],
  ["png", resourceTypes.Image],
  ["svg", resourceTypes.Image],
  ["tif", resourceTypes.Image],
  ["tiff", resourceTypes.Image],
  ["vue", resourceTypes.Document],
  ["webmanifest", resourceTypes.Manifest],
  ["webp", resourceTypes.Media],
  ["otf", resourceTypes.Font],
  ["ttc", resourceTypes.Font],
  ["ttf", resourceTypes.Font],
  ["woff", resourceTypes.Font],
  ["woff2", resourceTypes.Font],
  ["wasm", resourceTypes.Wasm]
]);
var mimeTypeByExtension = /* @__PURE__ */ new Map([
  // Web extensions
  ["js", "text/javascript"],
  ["mjs", "text/javascript"],
  ["css", "text/css"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["xml", "application/xml"],
  ["xsl", "application/xml"],
  ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json"],
  // HTML Embedded Scripts, ASP], JSP
  ["asp", "application/x-aspx"],
  ["aspx", "application/x-aspx"],
  ["jsp", "application/x-jsp"],
  // C/C++
  ["c", "text/x-c++src"],
  ["cc", "text/x-c++src"],
  ["cpp", "text/x-c++src"],
  ["h", "text/x-c++src"],
  ["m", "text/x-c++src"],
  ["mm", "text/x-c++src"],
  // CoffeeScript
  ["coffee", "text/x-coffeescript"],
  // Dart
  ["dart", "application/vnd.dart"],
  // TypeScript
  ["ts", "text/typescript"],
  ["tsx", "text/typescript-jsx"],
  // JSON
  ["json", "application/json"],
  ["gyp", "application/json"],
  ["gypi", "application/json"],
  ["map", "application/json"],
  // C#
  ["cs", "text/x-csharp"],
  // Go
  ["go", "text/x-go"],
  // Java
  ["java", "text/x-java"],
  // Kotlin
  ["kt", "text/x-kotlin"],
  // Scala
  ["scala", "text/x-scala"],
  // Less
  ["less", "text/x-less"],
  // PHP
  ["php", "application/x-httpd-php"],
  ["phtml", "application/x-httpd-php"],
  // Python
  ["py", "text/x-python"],
  // Shell
  ["sh", "text/x-sh"],
  // Google Stylesheets (GSS)
  ["gss", "text/x-gss"],
  // SASS (.sass & .scss)
  ["sass", "text/x-sass"],
  ["scss", "text/x-scss"],
  // Video Text Tracks.
  ["vtt", "text/vtt"],
  // LiveScript
  ["ls", "text/x-livescript"],
  // Markdown
  ["md", "text/markdown"],
  // ClojureScript
  ["cljs", "text/x-clojure"],
  ["cljc", "text/x-clojure"],
  ["cljx", "text/x-clojure"],
  // Stylus
  ["styl", "text/x-styl"],
  // JSX
  ["jsx", "text/jsx"],
  // Image
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/ico"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["jxl", "image/jxl"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["tif", "image/tif"],
  ["tiff", "image/tiff"],
  ["webp", "image/webp"],
  // Font
  ["otf", "font/otf"],
  ["ttc", "font/collection"],
  ["ttf", "font/ttf"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  // Angular
  ["component.html", "text/x.angular"],
  // Svelte
  ["svelte", "text/x.svelte"],
  // Vue
  ["vue", "text/x.vue"]
]);

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/core/common/SettingRegistration.ts
var UIStrings3 = {
  /**
   * @description Title of the Elements panel.
   */
  elements: "Elements",
  /**
   * @description Text for DevTools AI.
   */
  ai: "AI",
  /**
   * @description Text for DevTools appearance.
   */
  appearance: "Appearance",
  /**
   * @description Title of the Sources panel.
   */
  sources: "Sources",
  /**
   * @description Title of the Network panel.
   */
  network: "Network",
  /**
   * @description Title of the Performance panel.
   */
  performance: "Performance",
  /**
   * @description Title of the Console panel.
   */
  console: "Console",
  /**
   * @description Title of the Persistence setting category.
   */
  persistence: "Persistence",
  /**
   * @description Title of the Debugger setting category.
   */
  debugger: "Debugger",
  /**
   * @description Title of the Global setting category for shortcuts and settings available throughout DevTools.
   */
  global: "Global",
  /**
   * @description Title of the Rendering tool.
   */
  rendering: "Rendering",
  /**
   * @description Title of the Grid setting category for CSS Grid tooling.
   */
  grid: "Grid",
  /**
   * @description Title of the Mobile setting category.
   */
  mobile: "Mobile",
  /**
   * @description Title of the Memory panel setting category.
   */
  memory: "Memory",
  /**
   * @description Title of the Extension setting category.
   */
  extension: "Extension",
  /**
   * @description Title of the Adorner setting category.
   */
  adorner: "Adorner",
  /**
   * @description Header for the Account section in the settings UI. The Account
   * section allows users to see their signed-in account and configure which DevTools data is synced via Chrome Sync.
   */
  account: "Account"
};
var str_3 = i18nImpl_exports.registerUIStrings("core/common/SettingRegistration.ts", UIStrings3);
var i18nString = i18nImpl_exports.getLocalizedString.bind(void 0, str_3);

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/wasmparser/package/dist/esm/WasmDis.js
var WasmDis_exports = {};
__export(WasmDis_exports, {
  DefaultNameResolver: () => DefaultNameResolver,
  DevToolsNameGenerator: () => DevToolsNameGenerator,
  DevToolsNameResolver: () => DevToolsNameResolver,
  LabelMode: () => LabelMode,
  NameSectionReader: () => NameSectionReader,
  NumericNameResolver: () => NumericNameResolver,
  WasmDisassembler: () => WasmDisassembler
});

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/wasmparser/package/dist/esm/WasmParser.js
var WasmParser_exports = {};
__export(WasmParser_exports, {
  BinaryReader: () => BinaryReader,
  BinaryReaderState: () => BinaryReaderState,
  DataMode: () => DataMode,
  ElementMode: () => ElementMode,
  ExternalKind: () => ExternalKind,
  Int64: () => Int64,
  LinkingType: () => LinkingType,
  NameType: () => NameType,
  OperatorCode: () => OperatorCode,
  OperatorCodeNames: () => OperatorCodeNames,
  RelocType: () => RelocType,
  SectionCode: () => SectionCode,
  Type: () => Type,
  TypeKind: () => TypeKind,
  bytesToString: () => bytesToString
});
var WASM_MAGIC_NUMBER = 1836278016;
var WASM_SUPPORTED_EXPERIMENTAL_VERSION = 13;
var WASM_SUPPORTED_VERSION = 1;
var SectionCode;
(function(SectionCode2) {
  SectionCode2[SectionCode2["Unknown"] = -1] = "Unknown";
  SectionCode2[SectionCode2["Custom"] = 0] = "Custom";
  SectionCode2[SectionCode2["Type"] = 1] = "Type";
  SectionCode2[SectionCode2["Import"] = 2] = "Import";
  SectionCode2[SectionCode2["Function"] = 3] = "Function";
  SectionCode2[SectionCode2["Table"] = 4] = "Table";
  SectionCode2[SectionCode2["Memory"] = 5] = "Memory";
  SectionCode2[SectionCode2["Global"] = 6] = "Global";
  SectionCode2[SectionCode2["Export"] = 7] = "Export";
  SectionCode2[SectionCode2["Start"] = 8] = "Start";
  SectionCode2[SectionCode2["Element"] = 9] = "Element";
  SectionCode2[SectionCode2["Code"] = 10] = "Code";
  SectionCode2[SectionCode2["Data"] = 11] = "Data";
  SectionCode2[SectionCode2["Event"] = 13] = "Event";
})(SectionCode || (SectionCode = {}));
var OperatorCode;
(function(OperatorCode2) {
  OperatorCode2[OperatorCode2["unreachable"] = 0] = "unreachable";
  OperatorCode2[OperatorCode2["nop"] = 1] = "nop";
  OperatorCode2[OperatorCode2["block"] = 2] = "block";
  OperatorCode2[OperatorCode2["loop"] = 3] = "loop";
  OperatorCode2[OperatorCode2["if"] = 4] = "if";
  OperatorCode2[OperatorCode2["else"] = 5] = "else";
  OperatorCode2[OperatorCode2["try"] = 6] = "try";
  OperatorCode2[OperatorCode2["catch"] = 7] = "catch";
  OperatorCode2[OperatorCode2["throw"] = 8] = "throw";
  OperatorCode2[OperatorCode2["rethrow"] = 9] = "rethrow";
  OperatorCode2[OperatorCode2["unwind"] = 10] = "unwind";
  OperatorCode2[OperatorCode2["end"] = 11] = "end";
  OperatorCode2[OperatorCode2["br"] = 12] = "br";
  OperatorCode2[OperatorCode2["br_if"] = 13] = "br_if";
  OperatorCode2[OperatorCode2["br_table"] = 14] = "br_table";
  OperatorCode2[OperatorCode2["return"] = 15] = "return";
  OperatorCode2[OperatorCode2["call"] = 16] = "call";
  OperatorCode2[OperatorCode2["call_indirect"] = 17] = "call_indirect";
  OperatorCode2[OperatorCode2["return_call"] = 18] = "return_call";
  OperatorCode2[OperatorCode2["return_call_indirect"] = 19] = "return_call_indirect";
  OperatorCode2[OperatorCode2["call_ref"] = 20] = "call_ref";
  OperatorCode2[OperatorCode2["return_call_ref"] = 21] = "return_call_ref";
  OperatorCode2[OperatorCode2["let"] = 23] = "let";
  OperatorCode2[OperatorCode2["delegate"] = 24] = "delegate";
  OperatorCode2[OperatorCode2["catch_all"] = 25] = "catch_all";
  OperatorCode2[OperatorCode2["drop"] = 26] = "drop";
  OperatorCode2[OperatorCode2["select"] = 27] = "select";
  OperatorCode2[OperatorCode2["select_with_type"] = 28] = "select_with_type";
  OperatorCode2[OperatorCode2["local_get"] = 32] = "local_get";
  OperatorCode2[OperatorCode2["local_set"] = 33] = "local_set";
  OperatorCode2[OperatorCode2["local_tee"] = 34] = "local_tee";
  OperatorCode2[OperatorCode2["global_get"] = 35] = "global_get";
  OperatorCode2[OperatorCode2["global_set"] = 36] = "global_set";
  OperatorCode2[OperatorCode2["i32_load"] = 40] = "i32_load";
  OperatorCode2[OperatorCode2["i64_load"] = 41] = "i64_load";
  OperatorCode2[OperatorCode2["f32_load"] = 42] = "f32_load";
  OperatorCode2[OperatorCode2["f64_load"] = 43] = "f64_load";
  OperatorCode2[OperatorCode2["i32_load8_s"] = 44] = "i32_load8_s";
  OperatorCode2[OperatorCode2["i32_load8_u"] = 45] = "i32_load8_u";
  OperatorCode2[OperatorCode2["i32_load16_s"] = 46] = "i32_load16_s";
  OperatorCode2[OperatorCode2["i32_load16_u"] = 47] = "i32_load16_u";
  OperatorCode2[OperatorCode2["i64_load8_s"] = 48] = "i64_load8_s";
  OperatorCode2[OperatorCode2["i64_load8_u"] = 49] = "i64_load8_u";
  OperatorCode2[OperatorCode2["i64_load16_s"] = 50] = "i64_load16_s";
  OperatorCode2[OperatorCode2["i64_load16_u"] = 51] = "i64_load16_u";
  OperatorCode2[OperatorCode2["i64_load32_s"] = 52] = "i64_load32_s";
  OperatorCode2[OperatorCode2["i64_load32_u"] = 53] = "i64_load32_u";
  OperatorCode2[OperatorCode2["i32_store"] = 54] = "i32_store";
  OperatorCode2[OperatorCode2["i64_store"] = 55] = "i64_store";
  OperatorCode2[OperatorCode2["f32_store"] = 56] = "f32_store";
  OperatorCode2[OperatorCode2["f64_store"] = 57] = "f64_store";
  OperatorCode2[OperatorCode2["i32_store8"] = 58] = "i32_store8";
  OperatorCode2[OperatorCode2["i32_store16"] = 59] = "i32_store16";
  OperatorCode2[OperatorCode2["i64_store8"] = 60] = "i64_store8";
  OperatorCode2[OperatorCode2["i64_store16"] = 61] = "i64_store16";
  OperatorCode2[OperatorCode2["i64_store32"] = 62] = "i64_store32";
  OperatorCode2[OperatorCode2["current_memory"] = 63] = "current_memory";
  OperatorCode2[OperatorCode2["grow_memory"] = 64] = "grow_memory";
  OperatorCode2[OperatorCode2["i32_const"] = 65] = "i32_const";
  OperatorCode2[OperatorCode2["i64_const"] = 66] = "i64_const";
  OperatorCode2[OperatorCode2["f32_const"] = 67] = "f32_const";
  OperatorCode2[OperatorCode2["f64_const"] = 68] = "f64_const";
  OperatorCode2[OperatorCode2["i32_eqz"] = 69] = "i32_eqz";
  OperatorCode2[OperatorCode2["i32_eq"] = 70] = "i32_eq";
  OperatorCode2[OperatorCode2["i32_ne"] = 71] = "i32_ne";
  OperatorCode2[OperatorCode2["i32_lt_s"] = 72] = "i32_lt_s";
  OperatorCode2[OperatorCode2["i32_lt_u"] = 73] = "i32_lt_u";
  OperatorCode2[OperatorCode2["i32_gt_s"] = 74] = "i32_gt_s";
  OperatorCode2[OperatorCode2["i32_gt_u"] = 75] = "i32_gt_u";
  OperatorCode2[OperatorCode2["i32_le_s"] = 76] = "i32_le_s";
  OperatorCode2[OperatorCode2["i32_le_u"] = 77] = "i32_le_u";
  OperatorCode2[OperatorCode2["i32_ge_s"] = 78] = "i32_ge_s";
  OperatorCode2[OperatorCode2["i32_ge_u"] = 79] = "i32_ge_u";
  OperatorCode2[OperatorCode2["i64_eqz"] = 80] = "i64_eqz";
  OperatorCode2[OperatorCode2["i64_eq"] = 81] = "i64_eq";
  OperatorCode2[OperatorCode2["i64_ne"] = 82] = "i64_ne";
  OperatorCode2[OperatorCode2["i64_lt_s"] = 83] = "i64_lt_s";
  OperatorCode2[OperatorCode2["i64_lt_u"] = 84] = "i64_lt_u";
  OperatorCode2[OperatorCode2["i64_gt_s"] = 85] = "i64_gt_s";
  OperatorCode2[OperatorCode2["i64_gt_u"] = 86] = "i64_gt_u";
  OperatorCode2[OperatorCode2["i64_le_s"] = 87] = "i64_le_s";
  OperatorCode2[OperatorCode2["i64_le_u"] = 88] = "i64_le_u";
  OperatorCode2[OperatorCode2["i64_ge_s"] = 89] = "i64_ge_s";
  OperatorCode2[OperatorCode2["i64_ge_u"] = 90] = "i64_ge_u";
  OperatorCode2[OperatorCode2["f32_eq"] = 91] = "f32_eq";
  OperatorCode2[OperatorCode2["f32_ne"] = 92] = "f32_ne";
  OperatorCode2[OperatorCode2["f32_lt"] = 93] = "f32_lt";
  OperatorCode2[OperatorCode2["f32_gt"] = 94] = "f32_gt";
  OperatorCode2[OperatorCode2["f32_le"] = 95] = "f32_le";
  OperatorCode2[OperatorCode2["f32_ge"] = 96] = "f32_ge";
  OperatorCode2[OperatorCode2["f64_eq"] = 97] = "f64_eq";
  OperatorCode2[OperatorCode2["f64_ne"] = 98] = "f64_ne";
  OperatorCode2[OperatorCode2["f64_lt"] = 99] = "f64_lt";
  OperatorCode2[OperatorCode2["f64_gt"] = 100] = "f64_gt";
  OperatorCode2[OperatorCode2["f64_le"] = 101] = "f64_le";
  OperatorCode2[OperatorCode2["f64_ge"] = 102] = "f64_ge";
  OperatorCode2[OperatorCode2["i32_clz"] = 103] = "i32_clz";
  OperatorCode2[OperatorCode2["i32_ctz"] = 104] = "i32_ctz";
  OperatorCode2[OperatorCode2["i32_popcnt"] = 105] = "i32_popcnt";
  OperatorCode2[OperatorCode2["i32_add"] = 106] = "i32_add";
  OperatorCode2[OperatorCode2["i32_sub"] = 107] = "i32_sub";
  OperatorCode2[OperatorCode2["i32_mul"] = 108] = "i32_mul";
  OperatorCode2[OperatorCode2["i32_div_s"] = 109] = "i32_div_s";
  OperatorCode2[OperatorCode2["i32_div_u"] = 110] = "i32_div_u";
  OperatorCode2[OperatorCode2["i32_rem_s"] = 111] = "i32_rem_s";
  OperatorCode2[OperatorCode2["i32_rem_u"] = 112] = "i32_rem_u";
  OperatorCode2[OperatorCode2["i32_and"] = 113] = "i32_and";
  OperatorCode2[OperatorCode2["i32_or"] = 114] = "i32_or";
  OperatorCode2[OperatorCode2["i32_xor"] = 115] = "i32_xor";
  OperatorCode2[OperatorCode2["i32_shl"] = 116] = "i32_shl";
  OperatorCode2[OperatorCode2["i32_shr_s"] = 117] = "i32_shr_s";
  OperatorCode2[OperatorCode2["i32_shr_u"] = 118] = "i32_shr_u";
  OperatorCode2[OperatorCode2["i32_rotl"] = 119] = "i32_rotl";
  OperatorCode2[OperatorCode2["i32_rotr"] = 120] = "i32_rotr";
  OperatorCode2[OperatorCode2["i64_clz"] = 121] = "i64_clz";
  OperatorCode2[OperatorCode2["i64_ctz"] = 122] = "i64_ctz";
  OperatorCode2[OperatorCode2["i64_popcnt"] = 123] = "i64_popcnt";
  OperatorCode2[OperatorCode2["i64_add"] = 124] = "i64_add";
  OperatorCode2[OperatorCode2["i64_sub"] = 125] = "i64_sub";
  OperatorCode2[OperatorCode2["i64_mul"] = 126] = "i64_mul";
  OperatorCode2[OperatorCode2["i64_div_s"] = 127] = "i64_div_s";
  OperatorCode2[OperatorCode2["i64_div_u"] = 128] = "i64_div_u";
  OperatorCode2[OperatorCode2["i64_rem_s"] = 129] = "i64_rem_s";
  OperatorCode2[OperatorCode2["i64_rem_u"] = 130] = "i64_rem_u";
  OperatorCode2[OperatorCode2["i64_and"] = 131] = "i64_and";
  OperatorCode2[OperatorCode2["i64_or"] = 132] = "i64_or";
  OperatorCode2[OperatorCode2["i64_xor"] = 133] = "i64_xor";
  OperatorCode2[OperatorCode2["i64_shl"] = 134] = "i64_shl";
  OperatorCode2[OperatorCode2["i64_shr_s"] = 135] = "i64_shr_s";
  OperatorCode2[OperatorCode2["i64_shr_u"] = 136] = "i64_shr_u";
  OperatorCode2[OperatorCode2["i64_rotl"] = 137] = "i64_rotl";
  OperatorCode2[OperatorCode2["i64_rotr"] = 138] = "i64_rotr";
  OperatorCode2[OperatorCode2["f32_abs"] = 139] = "f32_abs";
  OperatorCode2[OperatorCode2["f32_neg"] = 140] = "f32_neg";
  OperatorCode2[OperatorCode2["f32_ceil"] = 141] = "f32_ceil";
  OperatorCode2[OperatorCode2["f32_floor"] = 142] = "f32_floor";
  OperatorCode2[OperatorCode2["f32_trunc"] = 143] = "f32_trunc";
  OperatorCode2[OperatorCode2["f32_nearest"] = 144] = "f32_nearest";
  OperatorCode2[OperatorCode2["f32_sqrt"] = 145] = "f32_sqrt";
  OperatorCode2[OperatorCode2["f32_add"] = 146] = "f32_add";
  OperatorCode2[OperatorCode2["f32_sub"] = 147] = "f32_sub";
  OperatorCode2[OperatorCode2["f32_mul"] = 148] = "f32_mul";
  OperatorCode2[OperatorCode2["f32_div"] = 149] = "f32_div";
  OperatorCode2[OperatorCode2["f32_min"] = 150] = "f32_min";
  OperatorCode2[OperatorCode2["f32_max"] = 151] = "f32_max";
  OperatorCode2[OperatorCode2["f32_copysign"] = 152] = "f32_copysign";
  OperatorCode2[OperatorCode2["f64_abs"] = 153] = "f64_abs";
  OperatorCode2[OperatorCode2["f64_neg"] = 154] = "f64_neg";
  OperatorCode2[OperatorCode2["f64_ceil"] = 155] = "f64_ceil";
  OperatorCode2[OperatorCode2["f64_floor"] = 156] = "f64_floor";
  OperatorCode2[OperatorCode2["f64_trunc"] = 157] = "f64_trunc";
  OperatorCode2[OperatorCode2["f64_nearest"] = 158] = "f64_nearest";
  OperatorCode2[OperatorCode2["f64_sqrt"] = 159] = "f64_sqrt";
  OperatorCode2[OperatorCode2["f64_add"] = 160] = "f64_add";
  OperatorCode2[OperatorCode2["f64_sub"] = 161] = "f64_sub";
  OperatorCode2[OperatorCode2["f64_mul"] = 162] = "f64_mul";
  OperatorCode2[OperatorCode2["f64_div"] = 163] = "f64_div";
  OperatorCode2[OperatorCode2["f64_min"] = 164] = "f64_min";
  OperatorCode2[OperatorCode2["f64_max"] = 165] = "f64_max";
  OperatorCode2[OperatorCode2["f64_copysign"] = 166] = "f64_copysign";
  OperatorCode2[OperatorCode2["i32_wrap_i64"] = 167] = "i32_wrap_i64";
  OperatorCode2[OperatorCode2["i32_trunc_f32_s"] = 168] = "i32_trunc_f32_s";
  OperatorCode2[OperatorCode2["i32_trunc_f32_u"] = 169] = "i32_trunc_f32_u";
  OperatorCode2[OperatorCode2["i32_trunc_f64_s"] = 170] = "i32_trunc_f64_s";
  OperatorCode2[OperatorCode2["i32_trunc_f64_u"] = 171] = "i32_trunc_f64_u";
  OperatorCode2[OperatorCode2["i64_extend_i32_s"] = 172] = "i64_extend_i32_s";
  OperatorCode2[OperatorCode2["i64_extend_i32_u"] = 173] = "i64_extend_i32_u";
  OperatorCode2[OperatorCode2["i64_trunc_f32_s"] = 174] = "i64_trunc_f32_s";
  OperatorCode2[OperatorCode2["i64_trunc_f32_u"] = 175] = "i64_trunc_f32_u";
  OperatorCode2[OperatorCode2["i64_trunc_f64_s"] = 176] = "i64_trunc_f64_s";
  OperatorCode2[OperatorCode2["i64_trunc_f64_u"] = 177] = "i64_trunc_f64_u";
  OperatorCode2[OperatorCode2["f32_convert_i32_s"] = 178] = "f32_convert_i32_s";
  OperatorCode2[OperatorCode2["f32_convert_i32_u"] = 179] = "f32_convert_i32_u";
  OperatorCode2[OperatorCode2["f32_convert_i64_s"] = 180] = "f32_convert_i64_s";
  OperatorCode2[OperatorCode2["f32_convert_i64_u"] = 181] = "f32_convert_i64_u";
  OperatorCode2[OperatorCode2["f32_demote_f64"] = 182] = "f32_demote_f64";
  OperatorCode2[OperatorCode2["f64_convert_i32_s"] = 183] = "f64_convert_i32_s";
  OperatorCode2[OperatorCode2["f64_convert_i32_u"] = 184] = "f64_convert_i32_u";
  OperatorCode2[OperatorCode2["f64_convert_i64_s"] = 185] = "f64_convert_i64_s";
  OperatorCode2[OperatorCode2["f64_convert_i64_u"] = 186] = "f64_convert_i64_u";
  OperatorCode2[OperatorCode2["f64_promote_f32"] = 187] = "f64_promote_f32";
  OperatorCode2[OperatorCode2["i32_reinterpret_f32"] = 188] = "i32_reinterpret_f32";
  OperatorCode2[OperatorCode2["i64_reinterpret_f64"] = 189] = "i64_reinterpret_f64";
  OperatorCode2[OperatorCode2["f32_reinterpret_i32"] = 190] = "f32_reinterpret_i32";
  OperatorCode2[OperatorCode2["f64_reinterpret_i64"] = 191] = "f64_reinterpret_i64";
  OperatorCode2[OperatorCode2["i32_extend8_s"] = 192] = "i32_extend8_s";
  OperatorCode2[OperatorCode2["i32_extend16_s"] = 193] = "i32_extend16_s";
  OperatorCode2[OperatorCode2["i64_extend8_s"] = 194] = "i64_extend8_s";
  OperatorCode2[OperatorCode2["i64_extend16_s"] = 195] = "i64_extend16_s";
  OperatorCode2[OperatorCode2["i64_extend32_s"] = 196] = "i64_extend32_s";
  OperatorCode2[OperatorCode2["prefix_0xfb"] = 251] = "prefix_0xfb";
  OperatorCode2[OperatorCode2["prefix_0xfc"] = 252] = "prefix_0xfc";
  OperatorCode2[OperatorCode2["prefix_0xfd"] = 253] = "prefix_0xfd";
  OperatorCode2[OperatorCode2["prefix_0xfe"] = 254] = "prefix_0xfe";
  OperatorCode2[OperatorCode2["i32_trunc_sat_f32_s"] = 64512] = "i32_trunc_sat_f32_s";
  OperatorCode2[OperatorCode2["i32_trunc_sat_f32_u"] = 64513] = "i32_trunc_sat_f32_u";
  OperatorCode2[OperatorCode2["i32_trunc_sat_f64_s"] = 64514] = "i32_trunc_sat_f64_s";
  OperatorCode2[OperatorCode2["i32_trunc_sat_f64_u"] = 64515] = "i32_trunc_sat_f64_u";
  OperatorCode2[OperatorCode2["i64_trunc_sat_f32_s"] = 64516] = "i64_trunc_sat_f32_s";
  OperatorCode2[OperatorCode2["i64_trunc_sat_f32_u"] = 64517] = "i64_trunc_sat_f32_u";
  OperatorCode2[OperatorCode2["i64_trunc_sat_f64_s"] = 64518] = "i64_trunc_sat_f64_s";
  OperatorCode2[OperatorCode2["i64_trunc_sat_f64_u"] = 64519] = "i64_trunc_sat_f64_u";
  OperatorCode2[OperatorCode2["memory_init"] = 64520] = "memory_init";
  OperatorCode2[OperatorCode2["data_drop"] = 64521] = "data_drop";
  OperatorCode2[OperatorCode2["memory_copy"] = 64522] = "memory_copy";
  OperatorCode2[OperatorCode2["memory_fill"] = 64523] = "memory_fill";
  OperatorCode2[OperatorCode2["table_init"] = 64524] = "table_init";
  OperatorCode2[OperatorCode2["elem_drop"] = 64525] = "elem_drop";
  OperatorCode2[OperatorCode2["table_copy"] = 64526] = "table_copy";
  OperatorCode2[OperatorCode2["table_grow"] = 64527] = "table_grow";
  OperatorCode2[OperatorCode2["table_size"] = 64528] = "table_size";
  OperatorCode2[OperatorCode2["table_fill"] = 64529] = "table_fill";
  OperatorCode2[OperatorCode2["table_get"] = 37] = "table_get";
  OperatorCode2[OperatorCode2["table_set"] = 38] = "table_set";
  OperatorCode2[OperatorCode2["ref_null"] = 208] = "ref_null";
  OperatorCode2[OperatorCode2["ref_is_null"] = 209] = "ref_is_null";
  OperatorCode2[OperatorCode2["ref_func"] = 210] = "ref_func";
  OperatorCode2[OperatorCode2["ref_as_non_null"] = 211] = "ref_as_non_null";
  OperatorCode2[OperatorCode2["br_on_null"] = 212] = "br_on_null";
  OperatorCode2[OperatorCode2["ref_eq"] = 213] = "ref_eq";
  OperatorCode2[OperatorCode2["br_on_non_null"] = 214] = "br_on_non_null";
  OperatorCode2[OperatorCode2["atomic_notify"] = 65024] = "atomic_notify";
  OperatorCode2[OperatorCode2["i32_atomic_wait"] = 65025] = "i32_atomic_wait";
  OperatorCode2[OperatorCode2["i64_atomic_wait"] = 65026] = "i64_atomic_wait";
  OperatorCode2[OperatorCode2["atomic_fence"] = 65027] = "atomic_fence";
  OperatorCode2[OperatorCode2["i32_atomic_load"] = 65040] = "i32_atomic_load";
  OperatorCode2[OperatorCode2["i64_atomic_load"] = 65041] = "i64_atomic_load";
  OperatorCode2[OperatorCode2["i32_atomic_load8_u"] = 65042] = "i32_atomic_load8_u";
  OperatorCode2[OperatorCode2["i32_atomic_load16_u"] = 65043] = "i32_atomic_load16_u";
  OperatorCode2[OperatorCode2["i64_atomic_load8_u"] = 65044] = "i64_atomic_load8_u";
  OperatorCode2[OperatorCode2["i64_atomic_load16_u"] = 65045] = "i64_atomic_load16_u";
  OperatorCode2[OperatorCode2["i64_atomic_load32_u"] = 65046] = "i64_atomic_load32_u";
  OperatorCode2[OperatorCode2["i32_atomic_store"] = 65047] = "i32_atomic_store";
  OperatorCode2[OperatorCode2["i64_atomic_store"] = 65048] = "i64_atomic_store";
  OperatorCode2[OperatorCode2["i32_atomic_store8"] = 65049] = "i32_atomic_store8";
  OperatorCode2[OperatorCode2["i32_atomic_store16"] = 65050] = "i32_atomic_store16";
  OperatorCode2[OperatorCode2["i64_atomic_store8"] = 65051] = "i64_atomic_store8";
  OperatorCode2[OperatorCode2["i64_atomic_store16"] = 65052] = "i64_atomic_store16";
  OperatorCode2[OperatorCode2["i64_atomic_store32"] = 65053] = "i64_atomic_store32";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_add"] = 65054] = "i32_atomic_rmw_add";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_add"] = 65055] = "i64_atomic_rmw_add";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_add_u"] = 65056] = "i32_atomic_rmw8_add_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_add_u"] = 65057] = "i32_atomic_rmw16_add_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_add_u"] = 65058] = "i64_atomic_rmw8_add_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_add_u"] = 65059] = "i64_atomic_rmw16_add_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_add_u"] = 65060] = "i64_atomic_rmw32_add_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_sub"] = 65061] = "i32_atomic_rmw_sub";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_sub"] = 65062] = "i64_atomic_rmw_sub";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_sub_u"] = 65063] = "i32_atomic_rmw8_sub_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_sub_u"] = 65064] = "i32_atomic_rmw16_sub_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_sub_u"] = 65065] = "i64_atomic_rmw8_sub_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_sub_u"] = 65066] = "i64_atomic_rmw16_sub_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_sub_u"] = 65067] = "i64_atomic_rmw32_sub_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_and"] = 65068] = "i32_atomic_rmw_and";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_and"] = 65069] = "i64_atomic_rmw_and";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_and_u"] = 65070] = "i32_atomic_rmw8_and_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_and_u"] = 65071] = "i32_atomic_rmw16_and_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_and_u"] = 65072] = "i64_atomic_rmw8_and_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_and_u"] = 65073] = "i64_atomic_rmw16_and_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_and_u"] = 65074] = "i64_atomic_rmw32_and_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_or"] = 65075] = "i32_atomic_rmw_or";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_or"] = 65076] = "i64_atomic_rmw_or";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_or_u"] = 65077] = "i32_atomic_rmw8_or_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_or_u"] = 65078] = "i32_atomic_rmw16_or_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_or_u"] = 65079] = "i64_atomic_rmw8_or_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_or_u"] = 65080] = "i64_atomic_rmw16_or_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_or_u"] = 65081] = "i64_atomic_rmw32_or_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_xor"] = 65082] = "i32_atomic_rmw_xor";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_xor"] = 65083] = "i64_atomic_rmw_xor";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_xor_u"] = 65084] = "i32_atomic_rmw8_xor_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_xor_u"] = 65085] = "i32_atomic_rmw16_xor_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_xor_u"] = 65086] = "i64_atomic_rmw8_xor_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_xor_u"] = 65087] = "i64_atomic_rmw16_xor_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_xor_u"] = 65088] = "i64_atomic_rmw32_xor_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_xchg"] = 65089] = "i32_atomic_rmw_xchg";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_xchg"] = 65090] = "i64_atomic_rmw_xchg";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_xchg_u"] = 65091] = "i32_atomic_rmw8_xchg_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_xchg_u"] = 65092] = "i32_atomic_rmw16_xchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_xchg_u"] = 65093] = "i64_atomic_rmw8_xchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_xchg_u"] = 65094] = "i64_atomic_rmw16_xchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_xchg_u"] = 65095] = "i64_atomic_rmw32_xchg_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw_cmpxchg"] = 65096] = "i32_atomic_rmw_cmpxchg";
  OperatorCode2[OperatorCode2["i64_atomic_rmw_cmpxchg"] = 65097] = "i64_atomic_rmw_cmpxchg";
  OperatorCode2[OperatorCode2["i32_atomic_rmw8_cmpxchg_u"] = 65098] = "i32_atomic_rmw8_cmpxchg_u";
  OperatorCode2[OperatorCode2["i32_atomic_rmw16_cmpxchg_u"] = 65099] = "i32_atomic_rmw16_cmpxchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw8_cmpxchg_u"] = 65100] = "i64_atomic_rmw8_cmpxchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw16_cmpxchg_u"] = 65101] = "i64_atomic_rmw16_cmpxchg_u";
  OperatorCode2[OperatorCode2["i64_atomic_rmw32_cmpxchg_u"] = 65102] = "i64_atomic_rmw32_cmpxchg_u";
  OperatorCode2[OperatorCode2["v128_load"] = 64768] = "v128_load";
  OperatorCode2[OperatorCode2["i16x8_load8x8_s"] = 64769] = "i16x8_load8x8_s";
  OperatorCode2[OperatorCode2["i16x8_load8x8_u"] = 64770] = "i16x8_load8x8_u";
  OperatorCode2[OperatorCode2["i32x4_load16x4_s"] = 64771] = "i32x4_load16x4_s";
  OperatorCode2[OperatorCode2["i32x4_load16x4_u"] = 64772] = "i32x4_load16x4_u";
  OperatorCode2[OperatorCode2["i64x2_load32x2_s"] = 64773] = "i64x2_load32x2_s";
  OperatorCode2[OperatorCode2["i64x2_load32x2_u"] = 64774] = "i64x2_load32x2_u";
  OperatorCode2[OperatorCode2["v8x16_load_splat"] = 64775] = "v8x16_load_splat";
  OperatorCode2[OperatorCode2["v16x8_load_splat"] = 64776] = "v16x8_load_splat";
  OperatorCode2[OperatorCode2["v32x4_load_splat"] = 64777] = "v32x4_load_splat";
  OperatorCode2[OperatorCode2["v64x2_load_splat"] = 64778] = "v64x2_load_splat";
  OperatorCode2[OperatorCode2["v128_store"] = 64779] = "v128_store";
  OperatorCode2[OperatorCode2["v128_const"] = 64780] = "v128_const";
  OperatorCode2[OperatorCode2["i8x16_shuffle"] = 64781] = "i8x16_shuffle";
  OperatorCode2[OperatorCode2["i8x16_swizzle"] = 64782] = "i8x16_swizzle";
  OperatorCode2[OperatorCode2["i8x16_splat"] = 64783] = "i8x16_splat";
  OperatorCode2[OperatorCode2["i16x8_splat"] = 64784] = "i16x8_splat";
  OperatorCode2[OperatorCode2["i32x4_splat"] = 64785] = "i32x4_splat";
  OperatorCode2[OperatorCode2["i64x2_splat"] = 64786] = "i64x2_splat";
  OperatorCode2[OperatorCode2["f32x4_splat"] = 64787] = "f32x4_splat";
  OperatorCode2[OperatorCode2["f64x2_splat"] = 64788] = "f64x2_splat";
  OperatorCode2[OperatorCode2["i8x16_extract_lane_s"] = 64789] = "i8x16_extract_lane_s";
  OperatorCode2[OperatorCode2["i8x16_extract_lane_u"] = 64790] = "i8x16_extract_lane_u";
  OperatorCode2[OperatorCode2["i8x16_replace_lane"] = 64791] = "i8x16_replace_lane";
  OperatorCode2[OperatorCode2["i16x8_extract_lane_s"] = 64792] = "i16x8_extract_lane_s";
  OperatorCode2[OperatorCode2["i16x8_extract_lane_u"] = 64793] = "i16x8_extract_lane_u";
  OperatorCode2[OperatorCode2["i16x8_replace_lane"] = 64794] = "i16x8_replace_lane";
  OperatorCode2[OperatorCode2["i32x4_extract_lane"] = 64795] = "i32x4_extract_lane";
  OperatorCode2[OperatorCode2["i32x4_replace_lane"] = 64796] = "i32x4_replace_lane";
  OperatorCode2[OperatorCode2["i64x2_extract_lane"] = 64797] = "i64x2_extract_lane";
  OperatorCode2[OperatorCode2["i64x2_replace_lane"] = 64798] = "i64x2_replace_lane";
  OperatorCode2[OperatorCode2["f32x4_extract_lane"] = 64799] = "f32x4_extract_lane";
  OperatorCode2[OperatorCode2["f32x4_replace_lane"] = 64800] = "f32x4_replace_lane";
  OperatorCode2[OperatorCode2["f64x2_extract_lane"] = 64801] = "f64x2_extract_lane";
  OperatorCode2[OperatorCode2["f64x2_replace_lane"] = 64802] = "f64x2_replace_lane";
  OperatorCode2[OperatorCode2["i8x16_eq"] = 64803] = "i8x16_eq";
  OperatorCode2[OperatorCode2["i8x16_ne"] = 64804] = "i8x16_ne";
  OperatorCode2[OperatorCode2["i8x16_lt_s"] = 64805] = "i8x16_lt_s";
  OperatorCode2[OperatorCode2["i8x16_lt_u"] = 64806] = "i8x16_lt_u";
  OperatorCode2[OperatorCode2["i8x16_gt_s"] = 64807] = "i8x16_gt_s";
  OperatorCode2[OperatorCode2["i8x16_gt_u"] = 64808] = "i8x16_gt_u";
  OperatorCode2[OperatorCode2["i8x16_le_s"] = 64809] = "i8x16_le_s";
  OperatorCode2[OperatorCode2["i8x16_le_u"] = 64810] = "i8x16_le_u";
  OperatorCode2[OperatorCode2["i8x16_ge_s"] = 64811] = "i8x16_ge_s";
  OperatorCode2[OperatorCode2["i8x16_ge_u"] = 64812] = "i8x16_ge_u";
  OperatorCode2[OperatorCode2["i16x8_eq"] = 64813] = "i16x8_eq";
  OperatorCode2[OperatorCode2["i16x8_ne"] = 64814] = "i16x8_ne";
  OperatorCode2[OperatorCode2["i16x8_lt_s"] = 64815] = "i16x8_lt_s";
  OperatorCode2[OperatorCode2["i16x8_lt_u"] = 64816] = "i16x8_lt_u";
  OperatorCode2[OperatorCode2["i16x8_gt_s"] = 64817] = "i16x8_gt_s";
  OperatorCode2[OperatorCode2["i16x8_gt_u"] = 64818] = "i16x8_gt_u";
  OperatorCode2[OperatorCode2["i16x8_le_s"] = 64819] = "i16x8_le_s";
  OperatorCode2[OperatorCode2["i16x8_le_u"] = 64820] = "i16x8_le_u";
  OperatorCode2[OperatorCode2["i16x8_ge_s"] = 64821] = "i16x8_ge_s";
  OperatorCode2[OperatorCode2["i16x8_ge_u"] = 64822] = "i16x8_ge_u";
  OperatorCode2[OperatorCode2["i32x4_eq"] = 64823] = "i32x4_eq";
  OperatorCode2[OperatorCode2["i32x4_ne"] = 64824] = "i32x4_ne";
  OperatorCode2[OperatorCode2["i32x4_lt_s"] = 64825] = "i32x4_lt_s";
  OperatorCode2[OperatorCode2["i32x4_lt_u"] = 64826] = "i32x4_lt_u";
  OperatorCode2[OperatorCode2["i32x4_gt_s"] = 64827] = "i32x4_gt_s";
  OperatorCode2[OperatorCode2["i32x4_gt_u"] = 64828] = "i32x4_gt_u";
  OperatorCode2[OperatorCode2["i32x4_le_s"] = 64829] = "i32x4_le_s";
  OperatorCode2[OperatorCode2["i32x4_le_u"] = 64830] = "i32x4_le_u";
  OperatorCode2[OperatorCode2["i32x4_ge_s"] = 64831] = "i32x4_ge_s";
  OperatorCode2[OperatorCode2["i32x4_ge_u"] = 64832] = "i32x4_ge_u";
  OperatorCode2[OperatorCode2["f32x4_eq"] = 64833] = "f32x4_eq";
  OperatorCode2[OperatorCode2["f32x4_ne"] = 64834] = "f32x4_ne";
  OperatorCode2[OperatorCode2["f32x4_lt"] = 64835] = "f32x4_lt";
  OperatorCode2[OperatorCode2["f32x4_gt"] = 64836] = "f32x4_gt";
  OperatorCode2[OperatorCode2["f32x4_le"] = 64837] = "f32x4_le";
  OperatorCode2[OperatorCode2["f32x4_ge"] = 64838] = "f32x4_ge";
  OperatorCode2[OperatorCode2["f64x2_eq"] = 64839] = "f64x2_eq";
  OperatorCode2[OperatorCode2["f64x2_ne"] = 64840] = "f64x2_ne";
  OperatorCode2[OperatorCode2["f64x2_lt"] = 64841] = "f64x2_lt";
  OperatorCode2[OperatorCode2["f64x2_gt"] = 64842] = "f64x2_gt";
  OperatorCode2[OperatorCode2["f64x2_le"] = 64843] = "f64x2_le";
  OperatorCode2[OperatorCode2["f64x2_ge"] = 64844] = "f64x2_ge";
  OperatorCode2[OperatorCode2["v128_not"] = 64845] = "v128_not";
  OperatorCode2[OperatorCode2["v128_and"] = 64846] = "v128_and";
  OperatorCode2[OperatorCode2["v128_andnot"] = 64847] = "v128_andnot";
  OperatorCode2[OperatorCode2["v128_or"] = 64848] = "v128_or";
  OperatorCode2[OperatorCode2["v128_xor"] = 64849] = "v128_xor";
  OperatorCode2[OperatorCode2["v128_bitselect"] = 64850] = "v128_bitselect";
  OperatorCode2[OperatorCode2["v128_any_true"] = 64851] = "v128_any_true";
  OperatorCode2[OperatorCode2["v128_load8_lane"] = 64852] = "v128_load8_lane";
  OperatorCode2[OperatorCode2["v128_load16_lane"] = 64853] = "v128_load16_lane";
  OperatorCode2[OperatorCode2["v128_load32_lane"] = 64854] = "v128_load32_lane";
  OperatorCode2[OperatorCode2["v128_load64_lane"] = 64855] = "v128_load64_lane";
  OperatorCode2[OperatorCode2["v128_store8_lane"] = 64856] = "v128_store8_lane";
  OperatorCode2[OperatorCode2["v128_store16_lane"] = 64857] = "v128_store16_lane";
  OperatorCode2[OperatorCode2["v128_store32_lane"] = 64858] = "v128_store32_lane";
  OperatorCode2[OperatorCode2["v128_store64_lane"] = 64859] = "v128_store64_lane";
  OperatorCode2[OperatorCode2["v128_load32_zero"] = 64860] = "v128_load32_zero";
  OperatorCode2[OperatorCode2["v128_load64_zero"] = 64861] = "v128_load64_zero";
  OperatorCode2[OperatorCode2["f32x4_demote_f64x2_zero"] = 64862] = "f32x4_demote_f64x2_zero";
  OperatorCode2[OperatorCode2["f64x2_promote_low_f32x4"] = 64863] = "f64x2_promote_low_f32x4";
  OperatorCode2[OperatorCode2["i8x16_abs"] = 64864] = "i8x16_abs";
  OperatorCode2[OperatorCode2["i8x16_neg"] = 64865] = "i8x16_neg";
  OperatorCode2[OperatorCode2["i8x16_popcnt"] = 64866] = "i8x16_popcnt";
  OperatorCode2[OperatorCode2["i8x16_all_true"] = 64867] = "i8x16_all_true";
  OperatorCode2[OperatorCode2["i8x16_bitmask"] = 64868] = "i8x16_bitmask";
  OperatorCode2[OperatorCode2["i8x16_narrow_i16x8_s"] = 64869] = "i8x16_narrow_i16x8_s";
  OperatorCode2[OperatorCode2["i8x16_narrow_i16x8_u"] = 64870] = "i8x16_narrow_i16x8_u";
  OperatorCode2[OperatorCode2["f32x4_ceil"] = 64871] = "f32x4_ceil";
  OperatorCode2[OperatorCode2["f32x4_floor"] = 64872] = "f32x4_floor";
  OperatorCode2[OperatorCode2["f32x4_trunc"] = 64873] = "f32x4_trunc";
  OperatorCode2[OperatorCode2["f32x4_nearest"] = 64874] = "f32x4_nearest";
  OperatorCode2[OperatorCode2["i8x16_shl"] = 64875] = "i8x16_shl";
  OperatorCode2[OperatorCode2["i8x16_shr_s"] = 64876] = "i8x16_shr_s";
  OperatorCode2[OperatorCode2["i8x16_shr_u"] = 64877] = "i8x16_shr_u";
  OperatorCode2[OperatorCode2["i8x16_add"] = 64878] = "i8x16_add";
  OperatorCode2[OperatorCode2["i8x16_add_sat_s"] = 64879] = "i8x16_add_sat_s";
  OperatorCode2[OperatorCode2["i8x16_add_sat_u"] = 64880] = "i8x16_add_sat_u";
  OperatorCode2[OperatorCode2["i8x16_sub"] = 64881] = "i8x16_sub";
  OperatorCode2[OperatorCode2["i8x16_sub_sat_s"] = 64882] = "i8x16_sub_sat_s";
  OperatorCode2[OperatorCode2["i8x16_sub_sat_u"] = 64883] = "i8x16_sub_sat_u";
  OperatorCode2[OperatorCode2["f64x2_ceil"] = 64884] = "f64x2_ceil";
  OperatorCode2[OperatorCode2["f64x2_floor"] = 64885] = "f64x2_floor";
  OperatorCode2[OperatorCode2["i8x16_min_s"] = 64886] = "i8x16_min_s";
  OperatorCode2[OperatorCode2["i8x16_min_u"] = 64887] = "i8x16_min_u";
  OperatorCode2[OperatorCode2["i8x16_max_s"] = 64888] = "i8x16_max_s";
  OperatorCode2[OperatorCode2["i8x16_max_u"] = 64889] = "i8x16_max_u";
  OperatorCode2[OperatorCode2["f64x2_trunc"] = 64890] = "f64x2_trunc";
  OperatorCode2[OperatorCode2["i8x16_avgr_u"] = 64891] = "i8x16_avgr_u";
  OperatorCode2[OperatorCode2["i16x8_extadd_pairwise_i8x16_s"] = 64892] = "i16x8_extadd_pairwise_i8x16_s";
  OperatorCode2[OperatorCode2["i16x8_extadd_pairwise_i8x16_u"] = 64893] = "i16x8_extadd_pairwise_i8x16_u";
  OperatorCode2[OperatorCode2["i32x4_extadd_pairwise_i16x8_s"] = 64894] = "i32x4_extadd_pairwise_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extadd_pairwise_i16x8_u"] = 64895] = "i32x4_extadd_pairwise_i16x8_u";
  OperatorCode2[OperatorCode2["i16x8_abs"] = 64896] = "i16x8_abs";
  OperatorCode2[OperatorCode2["i16x8_neg"] = 64897] = "i16x8_neg";
  OperatorCode2[OperatorCode2["i16x8_q15mulr_sat_s"] = 64898] = "i16x8_q15mulr_sat_s";
  OperatorCode2[OperatorCode2["i16x8_all_true"] = 64899] = "i16x8_all_true";
  OperatorCode2[OperatorCode2["i16x8_bitmask"] = 64900] = "i16x8_bitmask";
  OperatorCode2[OperatorCode2["i16x8_narrow_i32x4_s"] = 64901] = "i16x8_narrow_i32x4_s";
  OperatorCode2[OperatorCode2["i16x8_narrow_i32x4_u"] = 64902] = "i16x8_narrow_i32x4_u";
  OperatorCode2[OperatorCode2["i16x8_extend_low_i8x16_s"] = 64903] = "i16x8_extend_low_i8x16_s";
  OperatorCode2[OperatorCode2["i16x8_extend_high_i8x16_s"] = 64904] = "i16x8_extend_high_i8x16_s";
  OperatorCode2[OperatorCode2["i16x8_extend_low_i8x16_u"] = 64905] = "i16x8_extend_low_i8x16_u";
  OperatorCode2[OperatorCode2["i16x8_extend_high_i8x16_u"] = 64906] = "i16x8_extend_high_i8x16_u";
  OperatorCode2[OperatorCode2["i16x8_shl"] = 64907] = "i16x8_shl";
  OperatorCode2[OperatorCode2["i16x8_shr_s"] = 64908] = "i16x8_shr_s";
  OperatorCode2[OperatorCode2["i16x8_shr_u"] = 64909] = "i16x8_shr_u";
  OperatorCode2[OperatorCode2["i16x8_add"] = 64910] = "i16x8_add";
  OperatorCode2[OperatorCode2["i16x8_add_sat_s"] = 64911] = "i16x8_add_sat_s";
  OperatorCode2[OperatorCode2["i16x8_add_sat_u"] = 64912] = "i16x8_add_sat_u";
  OperatorCode2[OperatorCode2["i16x8_sub"] = 64913] = "i16x8_sub";
  OperatorCode2[OperatorCode2["i16x8_sub_sat_s"] = 64914] = "i16x8_sub_sat_s";
  OperatorCode2[OperatorCode2["i16x8_sub_sat_u"] = 64915] = "i16x8_sub_sat_u";
  OperatorCode2[OperatorCode2["f64x2_nearest"] = 64916] = "f64x2_nearest";
  OperatorCode2[OperatorCode2["i16x8_mul"] = 64917] = "i16x8_mul";
  OperatorCode2[OperatorCode2["i16x8_min_s"] = 64918] = "i16x8_min_s";
  OperatorCode2[OperatorCode2["i16x8_min_u"] = 64919] = "i16x8_min_u";
  OperatorCode2[OperatorCode2["i16x8_max_s"] = 64920] = "i16x8_max_s";
  OperatorCode2[OperatorCode2["i16x8_max_u"] = 64921] = "i16x8_max_u";
  OperatorCode2[OperatorCode2["i16x8_avgr_u"] = 64923] = "i16x8_avgr_u";
  OperatorCode2[OperatorCode2["i16x8_extmul_low_i8x16_s"] = 64924] = "i16x8_extmul_low_i8x16_s";
  OperatorCode2[OperatorCode2["i16x8_extmul_high_i8x16_s"] = 64925] = "i16x8_extmul_high_i8x16_s";
  OperatorCode2[OperatorCode2["i16x8_extmul_low_i8x16_u"] = 64926] = "i16x8_extmul_low_i8x16_u";
  OperatorCode2[OperatorCode2["i16x8_extmul_high_i8x16_u"] = 64927] = "i16x8_extmul_high_i8x16_u";
  OperatorCode2[OperatorCode2["i32x4_abs"] = 64928] = "i32x4_abs";
  OperatorCode2[OperatorCode2["i32x4_neg"] = 64929] = "i32x4_neg";
  OperatorCode2[OperatorCode2["i32x4_all_true"] = 64931] = "i32x4_all_true";
  OperatorCode2[OperatorCode2["i32x4_bitmask"] = 64932] = "i32x4_bitmask";
  OperatorCode2[OperatorCode2["i32x4_extend_low_i16x8_s"] = 64935] = "i32x4_extend_low_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extend_high_i16x8_s"] = 64936] = "i32x4_extend_high_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extend_low_i16x8_u"] = 64937] = "i32x4_extend_low_i16x8_u";
  OperatorCode2[OperatorCode2["i32x4_extend_high_i16x8_u"] = 64938] = "i32x4_extend_high_i16x8_u";
  OperatorCode2[OperatorCode2["i32x4_shl"] = 64939] = "i32x4_shl";
  OperatorCode2[OperatorCode2["i32x4_shr_s"] = 64940] = "i32x4_shr_s";
  OperatorCode2[OperatorCode2["i32x4_shr_u"] = 64941] = "i32x4_shr_u";
  OperatorCode2[OperatorCode2["i32x4_add"] = 64942] = "i32x4_add";
  OperatorCode2[OperatorCode2["i32x4_sub"] = 64945] = "i32x4_sub";
  OperatorCode2[OperatorCode2["i32x4_mul"] = 64949] = "i32x4_mul";
  OperatorCode2[OperatorCode2["i32x4_min_s"] = 64950] = "i32x4_min_s";
  OperatorCode2[OperatorCode2["i32x4_min_u"] = 64951] = "i32x4_min_u";
  OperatorCode2[OperatorCode2["i32x4_max_s"] = 64952] = "i32x4_max_s";
  OperatorCode2[OperatorCode2["i32x4_max_u"] = 64953] = "i32x4_max_u";
  OperatorCode2[OperatorCode2["i32x4_dot_i16x8_s"] = 64954] = "i32x4_dot_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extmul_low_i16x8_s"] = 64956] = "i32x4_extmul_low_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extmul_high_i16x8_s"] = 64957] = "i32x4_extmul_high_i16x8_s";
  OperatorCode2[OperatorCode2["i32x4_extmul_low_i16x8_u"] = 64958] = "i32x4_extmul_low_i16x8_u";
  OperatorCode2[OperatorCode2["i32x4_extmul_high_i16x8_u"] = 64959] = "i32x4_extmul_high_i16x8_u";
  OperatorCode2[OperatorCode2["i64x2_abs"] = 64960] = "i64x2_abs";
  OperatorCode2[OperatorCode2["i64x2_neg"] = 64961] = "i64x2_neg";
  OperatorCode2[OperatorCode2["i64x2_all_true"] = 64963] = "i64x2_all_true";
  OperatorCode2[OperatorCode2["i64x2_bitmask"] = 64964] = "i64x2_bitmask";
  OperatorCode2[OperatorCode2["i64x2_extend_low_i32x4_s"] = 64967] = "i64x2_extend_low_i32x4_s";
  OperatorCode2[OperatorCode2["i64x2_extend_high_i32x4_s"] = 64968] = "i64x2_extend_high_i32x4_s";
  OperatorCode2[OperatorCode2["i64x2_extend_low_i32x4_u"] = 64969] = "i64x2_extend_low_i32x4_u";
  OperatorCode2[OperatorCode2["i64x2_extend_high_i32x4_u"] = 64970] = "i64x2_extend_high_i32x4_u";
  OperatorCode2[OperatorCode2["i64x2_shl"] = 64971] = "i64x2_shl";
  OperatorCode2[OperatorCode2["i64x2_shr_s"] = 64972] = "i64x2_shr_s";
  OperatorCode2[OperatorCode2["i64x2_shr_u"] = 64973] = "i64x2_shr_u";
  OperatorCode2[OperatorCode2["i64x2_add"] = 64974] = "i64x2_add";
  OperatorCode2[OperatorCode2["i64x2_sub"] = 64977] = "i64x2_sub";
  OperatorCode2[OperatorCode2["i64x2_mul"] = 64981] = "i64x2_mul";
  OperatorCode2[OperatorCode2["i64x2_eq"] = 64982] = "i64x2_eq";
  OperatorCode2[OperatorCode2["i64x2_ne"] = 64983] = "i64x2_ne";
  OperatorCode2[OperatorCode2["i64x2_lt_s"] = 64984] = "i64x2_lt_s";
  OperatorCode2[OperatorCode2["i64x2_gt_s"] = 64985] = "i64x2_gt_s";
  OperatorCode2[OperatorCode2["i64x2_le_s"] = 64986] = "i64x2_le_s";
  OperatorCode2[OperatorCode2["i64x2_ge_s"] = 64987] = "i64x2_ge_s";
  OperatorCode2[OperatorCode2["i64x2_extmul_low_i32x4_s"] = 64988] = "i64x2_extmul_low_i32x4_s";
  OperatorCode2[OperatorCode2["i64x2_extmul_high_i32x4_s"] = 64989] = "i64x2_extmul_high_i32x4_s";
  OperatorCode2[OperatorCode2["i64x2_extmul_low_i32x4_u"] = 64990] = "i64x2_extmul_low_i32x4_u";
  OperatorCode2[OperatorCode2["i64x2_extmul_high_i32x4_u"] = 64991] = "i64x2_extmul_high_i32x4_u";
  OperatorCode2[OperatorCode2["f32x4_abs"] = 64992] = "f32x4_abs";
  OperatorCode2[OperatorCode2["f32x4_neg"] = 64993] = "f32x4_neg";
  OperatorCode2[OperatorCode2["f32x4_sqrt"] = 64995] = "f32x4_sqrt";
  OperatorCode2[OperatorCode2["f32x4_add"] = 64996] = "f32x4_add";
  OperatorCode2[OperatorCode2["f32x4_sub"] = 64997] = "f32x4_sub";
  OperatorCode2[OperatorCode2["f32x4_mul"] = 64998] = "f32x4_mul";
  OperatorCode2[OperatorCode2["f32x4_div"] = 64999] = "f32x4_div";
  OperatorCode2[OperatorCode2["f32x4_min"] = 65e3] = "f32x4_min";
  OperatorCode2[OperatorCode2["f32x4_max"] = 65001] = "f32x4_max";
  OperatorCode2[OperatorCode2["f32x4_pmin"] = 65002] = "f32x4_pmin";
  OperatorCode2[OperatorCode2["f32x4_pmax"] = 65003] = "f32x4_pmax";
  OperatorCode2[OperatorCode2["f64x2_abs"] = 65004] = "f64x2_abs";
  OperatorCode2[OperatorCode2["f64x2_neg"] = 65005] = "f64x2_neg";
  OperatorCode2[OperatorCode2["f64x2_sqrt"] = 65007] = "f64x2_sqrt";
  OperatorCode2[OperatorCode2["f64x2_add"] = 65008] = "f64x2_add";
  OperatorCode2[OperatorCode2["f64x2_sub"] = 65009] = "f64x2_sub";
  OperatorCode2[OperatorCode2["f64x2_mul"] = 65010] = "f64x2_mul";
  OperatorCode2[OperatorCode2["f64x2_div"] = 65011] = "f64x2_div";
  OperatorCode2[OperatorCode2["f64x2_min"] = 65012] = "f64x2_min";
  OperatorCode2[OperatorCode2["f64x2_max"] = 65013] = "f64x2_max";
  OperatorCode2[OperatorCode2["f64x2_pmin"] = 65014] = "f64x2_pmin";
  OperatorCode2[OperatorCode2["f64x2_pmax"] = 65015] = "f64x2_pmax";
  OperatorCode2[OperatorCode2["i32x4_trunc_sat_f32x4_s"] = 65016] = "i32x4_trunc_sat_f32x4_s";
  OperatorCode2[OperatorCode2["i32x4_trunc_sat_f32x4_u"] = 65017] = "i32x4_trunc_sat_f32x4_u";
  OperatorCode2[OperatorCode2["f32x4_convert_i32x4_s"] = 65018] = "f32x4_convert_i32x4_s";
  OperatorCode2[OperatorCode2["f32x4_convert_i32x4_u"] = 65019] = "f32x4_convert_i32x4_u";
  OperatorCode2[OperatorCode2["i32x4_trunc_sat_f64x2_s_zero"] = 65020] = "i32x4_trunc_sat_f64x2_s_zero";
  OperatorCode2[OperatorCode2["i32x4_trunc_sat_f64x2_u_zero"] = 65021] = "i32x4_trunc_sat_f64x2_u_zero";
  OperatorCode2[OperatorCode2["f64x2_convert_low_i32x4_s"] = 65022] = "f64x2_convert_low_i32x4_s";
  OperatorCode2[OperatorCode2["f64x2_convert_low_i32x4_u"] = 65023] = "f64x2_convert_low_i32x4_u";
  OperatorCode2[OperatorCode2["struct_new_with_rtt"] = 64257] = "struct_new_with_rtt";
  OperatorCode2[OperatorCode2["struct_new_default_with_rtt"] = 64258] = "struct_new_default_with_rtt";
  OperatorCode2[OperatorCode2["struct_get"] = 64259] = "struct_get";
  OperatorCode2[OperatorCode2["struct_get_s"] = 64260] = "struct_get_s";
  OperatorCode2[OperatorCode2["struct_get_u"] = 64261] = "struct_get_u";
  OperatorCode2[OperatorCode2["struct_set"] = 64262] = "struct_set";
  OperatorCode2[OperatorCode2["struct_new"] = 64263] = "struct_new";
  OperatorCode2[OperatorCode2["struct_new_default"] = 64264] = "struct_new_default";
  OperatorCode2[OperatorCode2["array_new_with_rtt"] = 64273] = "array_new_with_rtt";
  OperatorCode2[OperatorCode2["array_new_default_with_rtt"] = 64274] = "array_new_default_with_rtt";
  OperatorCode2[OperatorCode2["array_get"] = 64275] = "array_get";
  OperatorCode2[OperatorCode2["array_get_s"] = 64276] = "array_get_s";
  OperatorCode2[OperatorCode2["array_get_u"] = 64277] = "array_get_u";
  OperatorCode2[OperatorCode2["array_set"] = 64278] = "array_set";
  OperatorCode2[OperatorCode2["array_len"] = 64279] = "array_len";
  OperatorCode2[OperatorCode2["array_copy"] = 64280] = "array_copy";
  OperatorCode2[OperatorCode2["array_init"] = 64281] = "array_init";
  OperatorCode2[OperatorCode2["array_init_static"] = 64282] = "array_init_static";
  OperatorCode2[OperatorCode2["array_new"] = 64283] = "array_new";
  OperatorCode2[OperatorCode2["array_new_default"] = 64284] = "array_new_default";
  OperatorCode2[OperatorCode2["i31_new"] = 64288] = "i31_new";
  OperatorCode2[OperatorCode2["i31_get_s"] = 64289] = "i31_get_s";
  OperatorCode2[OperatorCode2["i31_get_u"] = 64290] = "i31_get_u";
  OperatorCode2[OperatorCode2["rtt_canon"] = 64304] = "rtt_canon";
  OperatorCode2[OperatorCode2["rtt_sub"] = 64305] = "rtt_sub";
  OperatorCode2[OperatorCode2["rtt_fresh_sub"] = 64306] = "rtt_fresh_sub";
  OperatorCode2[OperatorCode2["ref_test"] = 64320] = "ref_test";
  OperatorCode2[OperatorCode2["ref_test_static"] = 64324] = "ref_test_static";
  OperatorCode2[OperatorCode2["ref_cast"] = 64321] = "ref_cast";
  OperatorCode2[OperatorCode2["ref_cast_static"] = 64325] = "ref_cast_static";
  OperatorCode2[OperatorCode2["br_on_cast"] = 64322] = "br_on_cast";
  OperatorCode2[OperatorCode2["br_on_cast_static"] = 64326] = "br_on_cast_static";
  OperatorCode2[OperatorCode2["br_on_cast_fail"] = 64323] = "br_on_cast_fail";
  OperatorCode2[OperatorCode2["br_on_cast_static_fail"] = 64327] = "br_on_cast_static_fail";
  OperatorCode2[OperatorCode2["ref_is_func"] = 64336] = "ref_is_func";
  OperatorCode2[OperatorCode2["ref_is_data"] = 64337] = "ref_is_data";
  OperatorCode2[OperatorCode2["ref_is_i31"] = 64338] = "ref_is_i31";
  OperatorCode2[OperatorCode2["ref_as_func"] = 64344] = "ref_as_func";
  OperatorCode2[OperatorCode2["ref_as_data"] = 64345] = "ref_as_data";
  OperatorCode2[OperatorCode2["ref_as_i31"] = 64346] = "ref_as_i31";
  OperatorCode2[OperatorCode2["br_on_func"] = 64352] = "br_on_func";
  OperatorCode2[OperatorCode2["br_on_data"] = 64353] = "br_on_data";
  OperatorCode2[OperatorCode2["br_on_i31"] = 64354] = "br_on_i31";
  OperatorCode2[OperatorCode2["br_on_non_func"] = 64355] = "br_on_non_func";
  OperatorCode2[OperatorCode2["br_on_non_data"] = 64356] = "br_on_non_data";
  OperatorCode2[OperatorCode2["br_on_non_i31"] = 64357] = "br_on_non_i31";
})(OperatorCode || (OperatorCode = {}));
var OperatorCodeNames = [
  "unreachable",
  "nop",
  "block",
  "loop",
  "if",
  "else",
  "try",
  "catch",
  "throw",
  "rethrow",
  "unwind",
  "end",
  "br",
  "br_if",
  "br_table",
  "return",
  "call",
  "call_indirect",
  "return_call",
  "return_call_indirect",
  "call_ref",
  "return_call_ref",
  void 0,
  "let",
  "delegate",
  "catch_all",
  "drop",
  "select",
  "select",
  void 0,
  void 0,
  void 0,
  "local.get",
  "local.set",
  "local.tee",
  "global.get",
  "global.set",
  "table.get",
  "table.set",
  void 0,
  "i32.load",
  "i64.load",
  "f32.load",
  "f64.load",
  "i32.load8_s",
  "i32.load8_u",
  "i32.load16_s",
  "i32.load16_u",
  "i64.load8_s",
  "i64.load8_u",
  "i64.load16_s",
  "i64.load16_u",
  "i64.load32_s",
  "i64.load32_u",
  "i32.store",
  "i64.store",
  "f32.store",
  "f64.store",
  "i32.store8",
  "i32.store16",
  "i64.store8",
  "i64.store16",
  "i64.store32",
  "current_memory",
  "memory.grow",
  "i32.const",
  "i64.const",
  "f32.const",
  "f64.const",
  "i32.eqz",
  "i32.eq",
  "i32.ne",
  "i32.lt_s",
  "i32.lt_u",
  "i32.gt_s",
  "i32.gt_u",
  "i32.le_s",
  "i32.le_u",
  "i32.ge_s",
  "i32.ge_u",
  "i64.eqz",
  "i64.eq",
  "i64.ne",
  "i64.lt_s",
  "i64.lt_u",
  "i64.gt_s",
  "i64.gt_u",
  "i64.le_s",
  "i64.le_u",
  "i64.ge_s",
  "i64.ge_u",
  "f32.eq",
  "f32.ne",
  "f32.lt",
  "f32.gt",
  "f32.le",
  "f32.ge",
  "f64.eq",
  "f64.ne",
  "f64.lt",
  "f64.gt",
  "f64.le",
  "f64.ge",
  "i32.clz",
  "i32.ctz",
  "i32.popcnt",
  "i32.add",
  "i32.sub",
  "i32.mul",
  "i32.div_s",
  "i32.div_u",
  "i32.rem_s",
  "i32.rem_u",
  "i32.and",
  "i32.or",
  "i32.xor",
  "i32.shl",
  "i32.shr_s",
  "i32.shr_u",
  "i32.rotl",
  "i32.rotr",
  "i64.clz",
  "i64.ctz",
  "i64.popcnt",
  "i64.add",
  "i64.sub",
  "i64.mul",
  "i64.div_s",
  "i64.div_u",
  "i64.rem_s",
  "i64.rem_u",
  "i64.and",
  "i64.or",
  "i64.xor",
  "i64.shl",
  "i64.shr_s",
  "i64.shr_u",
  "i64.rotl",
  "i64.rotr",
  "f32.abs",
  "f32.neg",
  "f32.ceil",
  "f32.floor",
  "f32.trunc",
  "f32.nearest",
  "f32.sqrt",
  "f32.add",
  "f32.sub",
  "f32.mul",
  "f32.div",
  "f32.min",
  "f32.max",
  "f32.copysign",
  "f64.abs",
  "f64.neg",
  "f64.ceil",
  "f64.floor",
  "f64.trunc",
  "f64.nearest",
  "f64.sqrt",
  "f64.add",
  "f64.sub",
  "f64.mul",
  "f64.div",
  "f64.min",
  "f64.max",
  "f64.copysign",
  "i32.wrap_i64",
  "i32.trunc_f32_s",
  "i32.trunc_f32_u",
  "i32.trunc_f64_s",
  "i32.trunc_f64_u",
  "i64.extend_i32_s",
  "i64.extend_i32_u",
  "i64.trunc_f32_s",
  "i64.trunc_f32_u",
  "i64.trunc_f64_s",
  "i64.trunc_f64_u",
  "f32.convert_i32_s",
  "f32.convert_i32_u",
  "f32.convert_i64_s",
  "f32.convert_i64_u",
  "f32.demote_f64",
  "f64.convert_i32_s",
  "f64.convert_i32_u",
  "f64.convert_i64_s",
  "f64.convert_i64_u",
  "f64.promote_f32",
  "i32.reinterpret_f32",
  "i64.reinterpret_f64",
  "f32.reinterpret_i32",
  "f64.reinterpret_i64",
  "i32.extend8_s",
  "i32.extend16_s",
  "i64.extend8_s",
  "i64.extend16_s",
  "i64.extend32_s",
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  "ref.null",
  "ref.is_null",
  "ref.func",
  "ref.as_non_null",
  "br_on_null",
  "ref.eq",
  "br_on_non_null",
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0
];
[
  "i32.trunc_sat_f32_s",
  "i32.trunc_sat_f32_u",
  "i32.trunc_sat_f64_s",
  "i32.trunc_sat_f64_u",
  "i64.trunc_sat_f32_s",
  "i64.trunc_sat_f32_u",
  "i64.trunc_sat_f64_s",
  "i64.trunc_sat_f64_u",
  "memory.init",
  "data.drop",
  "memory.copy",
  "memory.fill",
  "table.init",
  "elem.drop",
  "table.copy",
  "table.grow",
  "table.size",
  "table.fill"
].forEach((s, i) => {
  OperatorCodeNames[64512 | i] = s;
});
[
  "v128.load",
  "i16x8.load8x8_s",
  "i16x8.load8x8_u",
  "i32x4.load16x4_s",
  "i32x4.load16x4_u",
  "i64x2.load32x2_s",
  "i64x2.load32x2_u",
  "v8x16.load_splat",
  "v16x8.load_splat",
  "v32x4.load_splat",
  "v64x2.load_splat",
  "v128.store",
  "v128.const",
  "i8x16.shuffle",
  "i8x16.swizzle",
  "i8x16.splat",
  "i16x8.splat",
  "i32x4.splat",
  "i64x2.splat",
  "f32x4.splat",
  "f64x2.splat",
  "i8x16.extract_lane_s",
  "i8x16.extract_lane_u",
  "i8x16.replace_lane",
  "i16x8.extract_lane_s",
  "i16x8.extract_lane_u",
  "i16x8.replace_lane",
  "i32x4.extract_lane",
  "i32x4.replace_lane",
  "i64x2.extract_lane",
  "i64x2.replace_lane",
  "f32x4.extract_lane",
  "f32x4.replace_lane",
  "f64x2.extract_lane",
  "f64x2.replace_lane",
  "i8x16.eq",
  "i8x16.ne",
  "i8x16.lt_s",
  "i8x16.lt_u",
  "i8x16.gt_s",
  "i8x16.gt_u",
  "i8x16.le_s",
  "i8x16.le_u",
  "i8x16.ge_s",
  "i8x16.ge_u",
  "i16x8.eq",
  "i16x8.ne",
  "i16x8.lt_s",
  "i16x8.lt_u",
  "i16x8.gt_s",
  "i16x8.gt_u",
  "i16x8.le_s",
  "i16x8.le_u",
  "i16x8.ge_s",
  "i16x8.ge_u",
  "i32x4.eq",
  "i32x4.ne",
  "i32x4.lt_s",
  "i32x4.lt_u",
  "i32x4.gt_s",
  "i32x4.gt_u",
  "i32x4.le_s",
  "i32x4.le_u",
  "i32x4.ge_s",
  "i32x4.ge_u",
  "f32x4.eq",
  "f32x4.ne",
  "f32x4.lt",
  "f32x4.gt",
  "f32x4.le",
  "f32x4.ge",
  "f64x2.eq",
  "f64x2.ne",
  "f64x2.lt",
  "f64x2.gt",
  "f64x2.le",
  "f64x2.ge",
  "v128.not",
  "v128.and",
  "v128.andnot",
  "v128.or",
  "v128.xor",
  "v128.bitselect",
  "v128.any_true",
  "v128.load8_lane",
  "v128.load16_lane",
  "v128.load32_lane",
  "v128.load64_lane",
  "v128.store8_lane",
  "v128.store16_lane",
  "v128.store32_lane",
  "v128.store64_lane",
  "v128.load32_zero",
  "v128.load64_zero",
  "f32x4.demote_f64x2_zero",
  "f64x2.promote_low_f32x4",
  "i8x16.abs",
  "i8x16.neg",
  "i8x16_popcnt",
  "i8x16.all_true",
  "i8x16.bitmask",
  "i8x16.narrow_i16x8_s",
  "i8x16.narrow_i16x8_u",
  "f32x4.ceil",
  "f32x4.floor",
  "f32x4.trunc",
  "f32x4.nearest",
  "i8x16.shl",
  "i8x16.shr_s",
  "i8x16.shr_u",
  "i8x16.add",
  "i8x16.add_sat_s",
  "i8x16.add_sat_u",
  "i8x16.sub",
  "i8x16.sub_sat_s",
  "i8x16.sub_sat_u",
  "f64x2.ceil",
  "f64x2.floor",
  "i8x16.min_s",
  "i8x16.min_u",
  "i8x16.max_s",
  "i8x16.max_u",
  "f64x2.trunc",
  "i8x16.avgr_u",
  "i16x8.extadd_pairwise_i8x16_s",
  "i16x8.extadd_pairwise_i8x16_u",
  "i32x4.extadd_pairwise_i16x8_s",
  "i32x4.extadd_pairwise_i16x8_u",
  "i16x8.abs",
  "i16x8.neg",
  "i16x8.q15mulr_sat_s",
  "i16x8.all_true",
  "i16x8.bitmask",
  "i16x8.narrow_i32x4_s",
  "i16x8.narrow_i32x4_u",
  "i16x8.extend_low_i8x16_s",
  "i16x8.extend_high_i8x16_s",
  "i16x8.extend_low_i8x16_u",
  "i16x8.extend_high_i8x16_u",
  "i16x8.shl",
  "i16x8.shr_s",
  "i16x8.shr_u",
  "i16x8.add",
  "i16x8.add_sat_s",
  "i16x8.add_sat_u",
  "i16x8.sub",
  "i16x8.sub_sat_s",
  "i16x8.sub_sat_u",
  "f64x2.nearest",
  "i16x8.mul",
  "i16x8.min_s",
  "i16x8.min_u",
  "i16x8.max_s",
  "i16x8.max_u",
  void 0,
  "i16x8.avgr_u",
  "i16x8.extmul_low_i8x16_s",
  "i16x8.extmul_high_i8x16_s",
  "i16x8.extmul_low_i8x16_u",
  "i16x8.extmul_high_i8x16_u",
  "i32x4.abs",
  "i32x4.neg",
  void 0,
  "i32x4.all_true",
  "i32x4.bitmask",
  void 0,
  void 0,
  "i32x4.extend_low_i16x8_s",
  "i32x4.extend_high_i16x8_s",
  "i32x4.extend_low_i16x8_u",
  "i32x4.extend_high_i16x8_u",
  "i32x4.shl",
  "i32x4.shr_s",
  "i32x4.shr_u",
  "i32x4.add",
  void 0,
  void 0,
  "i32x4.sub",
  void 0,
  void 0,
  void 0,
  "i32x4.mul",
  "i32x4.min_s",
  "i32x4.min_u",
  "i32x4.max_s",
  "i32x4.max_u",
  "i32x4.dot_i16x8_s",
  void 0,
  "i32x4.extmul_low_i16x8_s",
  "i32x4.extmul_high_i16x8_s",
  "i32x4.extmul_low_i16x8_u",
  "i32x4.extmul_high_i16x8_u",
  "i64x2.abs",
  "i64x2.neg",
  void 0,
  "i64x2.all_true",
  "i64x2.bitmask",
  void 0,
  void 0,
  "i64x2.extend_low_i32x4_s",
  "i64x2.extend_high_i32x4_s",
  "i64x2.extend_low_i32x4_u",
  "i64x2.extend_high_i32x4_u",
  "i64x2.shl",
  "i64x2.shr_s",
  "i64x2.shr_u",
  "i64x2.add",
  void 0,
  void 0,
  "i64x2.sub",
  void 0,
  void 0,
  void 0,
  "i64x2.mul",
  "i64x2.eq",
  "i64x2.ne",
  "i64x2.lt_s",
  "i64x2.gt_s",
  "i64x2.le_s",
  "i64x2.ge_s",
  "i64x2.extmul_low_i32x4_s",
  "i64x2.extmul_high_i32x4_s",
  "i64x2.extmul_low_i32x4_u",
  "i64x2.extmul_high_i32x4_u",
  "f32x4.abs",
  "f32x4.neg",
  void 0,
  "f32x4.sqrt",
  "f32x4.add",
  "f32x4.sub",
  "f32x4.mul",
  "f32x4.div",
  "f32x4.min",
  "f32x4.max",
  "f32x4.pmin",
  "f32x4.pmax",
  "f64x2.abs",
  "f64x2.neg",
  void 0,
  "f64x2.sqrt",
  "f64x2.add",
  "f64x2.sub",
  "f64x2.mul",
  "f64x2.div",
  "f64x2.min",
  "f64x2.max",
  "f64x2.pmin",
  "f64x2.pmax",
  "i32x4.trunc_sat_f32x4_s",
  "i32x4.trunc_sat_f32x4_u",
  "f32x4.convert_i32x4_s",
  "f32x4.convert_i32x4_u",
  "i32x4.trunc_sat_f64x2_s_zero",
  "i32x4.trunc_sat_f64x2_u_zero",
  "f64x2.convert_low_i32x4_s",
  "f64x2.convert_low_i32x4_u"
].forEach((s, i) => {
  OperatorCodeNames[64768 | i] = s;
});
[
  "atomic.notify",
  "i32.atomic.wait",
  "i64.atomic.wait",
  "atomic.fence",
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  void 0,
  "i32.atomic.load",
  "i64.atomic.load",
  "i32.atomic.load8_u",
  "i32.atomic.load16_u",
  "i64.atomic.load8_u",
  "i64.atomic.load16_u",
  "i64.atomic.load32_u",
  "i32.atomic.store",
  "i64.atomic.store",
  "i32.atomic.store8",
  "i32.atomic.store16",
  "i64.atomic.store8",
  "i64.atomic.store16",
  "i64.atomic.store32",
  "i32.atomic.rmw.add",
  "i64.atomic.rmw.add",
  "i32.atomic.rmw8.add_u",
  "i32.atomic.rmw16.add_u",
  "i64.atomic.rmw8.add_u",
  "i64.atomic.rmw16.add_u",
  "i64.atomic.rmw32.add_u",
  "i32.atomic.rmw.sub",
  "i64.atomic.rmw.sub",
  "i32.atomic.rmw8.sub_u",
  "i32.atomic.rmw16.sub_u",
  "i64.atomic.rmw8.sub_u",
  "i64.atomic.rmw16.sub_u",
  "i64.atomic.rmw32.sub_u",
  "i32.atomic.rmw.and",
  "i64.atomic.rmw.and",
  "i32.atomic.rmw8.and_u",
  "i32.atomic.rmw16.and_u",
  "i64.atomic.rmw8.and_u",
  "i64.atomic.rmw16.and_u",
  "i64.atomic.rmw32.and_u",
  "i32.atomic.rmw.or",
  "i64.atomic.rmw.or",
  "i32.atomic.rmw8.or_u",
  "i32.atomic.rmw16.or_u",
  "i64.atomic.rmw8.or_u",
  "i64.atomic.rmw16.or_u",
  "i64.atomic.rmw32.or_u",
  "i32.atomic.rmw.xor",
  "i64.atomic.rmw.xor",
  "i32.atomic.rmw8.xor_u",
  "i32.atomic.rmw16.xor_u",
  "i64.atomic.rmw8.xor_u",
  "i64.atomic.rmw16.xor_u",
  "i64.atomic.rmw32.xor_u",
  "i32.atomic.rmw.xchg",
  "i64.atomic.rmw.xchg",
  "i32.atomic.rmw8.xchg_u",
  "i32.atomic.rmw16.xchg_u",
  "i64.atomic.rmw8.xchg_u",
  "i64.atomic.rmw16.xchg_u",
  "i64.atomic.rmw32.xchg_u",
  "i32.atomic.rmw.cmpxchg",
  "i64.atomic.rmw.cmpxchg",
  "i32.atomic.rmw8.cmpxchg_u",
  "i32.atomic.rmw16.cmpxchg_u",
  "i64.atomic.rmw8.cmpxchg_u",
  "i64.atomic.rmw16.cmpxchg_u",
  "i64.atomic.rmw32.cmpxchg_u"
].forEach((s, i) => {
  OperatorCodeNames[65024 | i] = s;
});
OperatorCodeNames[64257] = "struct.new_with_rtt";
OperatorCodeNames[64258] = "struct.new_default_with_rtt";
OperatorCodeNames[64259] = "struct.get";
OperatorCodeNames[64260] = "struct.get_s";
OperatorCodeNames[64261] = "struct.get_u";
OperatorCodeNames[64262] = "struct.set";
OperatorCodeNames[64263] = "struct.new";
OperatorCodeNames[64264] = "struct.new_default";
OperatorCodeNames[64273] = "array.new_with_rtt";
OperatorCodeNames[64274] = "array.new_default_with_rtt";
OperatorCodeNames[64275] = "array.get";
OperatorCodeNames[64276] = "array.get_s";
OperatorCodeNames[64277] = "array.get_u";
OperatorCodeNames[64278] = "array.set";
OperatorCodeNames[64279] = "array.len";
OperatorCodeNames[64280] = "array.copy";
OperatorCodeNames[64281] = "array.init";
OperatorCodeNames[64282] = "array.init_static";
OperatorCodeNames[64283] = "array.new";
OperatorCodeNames[64284] = "array.new_default";
OperatorCodeNames[64288] = "i31.new";
OperatorCodeNames[64289] = "i31.get_s";
OperatorCodeNames[64290] = "i31.get_u";
OperatorCodeNames[64304] = "rtt.canon";
OperatorCodeNames[64305] = "rtt.sub";
OperatorCodeNames[64306] = "rtt.fresh_sub";
OperatorCodeNames[64320] = "ref.test";
OperatorCodeNames[64321] = "ref.cast";
OperatorCodeNames[64322] = "br_on_cast";
OperatorCodeNames[64323] = "br_on_cast_fail";
OperatorCodeNames[64324] = "ref.test_static";
OperatorCodeNames[64325] = "ref.cast_static";
OperatorCodeNames[64326] = "br_on_cast_static";
OperatorCodeNames[64327] = "br_on_cast_static_fail";
OperatorCodeNames[64336] = "ref.is_func";
OperatorCodeNames[64337] = "ref.is_data";
OperatorCodeNames[64338] = "ref.is_i31";
OperatorCodeNames[64344] = "ref.as_func";
OperatorCodeNames[64345] = "ref.as_data";
OperatorCodeNames[64346] = "ref.as_i31";
OperatorCodeNames[64352] = "br_on_func";
OperatorCodeNames[64353] = "br_on_data";
OperatorCodeNames[64354] = "br_on_i31";
OperatorCodeNames[64355] = "br_on_non_func";
OperatorCodeNames[64356] = "br_on_non_data";
OperatorCodeNames[64357] = "br_on_non_i31";
var ExternalKind;
(function(ExternalKind2) {
  ExternalKind2[ExternalKind2["Function"] = 0] = "Function";
  ExternalKind2[ExternalKind2["Table"] = 1] = "Table";
  ExternalKind2[ExternalKind2["Memory"] = 2] = "Memory";
  ExternalKind2[ExternalKind2["Global"] = 3] = "Global";
  ExternalKind2[ExternalKind2["Event"] = 4] = "Event";
})(ExternalKind || (ExternalKind = {}));
var TypeKind;
(function(TypeKind2) {
  TypeKind2[TypeKind2["unspecified"] = 0] = "unspecified";
  TypeKind2[TypeKind2["i32"] = -1] = "i32";
  TypeKind2[TypeKind2["i64"] = -2] = "i64";
  TypeKind2[TypeKind2["f32"] = -3] = "f32";
  TypeKind2[TypeKind2["f64"] = -4] = "f64";
  TypeKind2[TypeKind2["v128"] = -5] = "v128";
  TypeKind2[TypeKind2["i8"] = -6] = "i8";
  TypeKind2[TypeKind2["i16"] = -7] = "i16";
  TypeKind2[TypeKind2["funcref"] = -16] = "funcref";
  TypeKind2[TypeKind2["externref"] = -17] = "externref";
  TypeKind2[TypeKind2["anyref"] = -18] = "anyref";
  TypeKind2[TypeKind2["eqref"] = -19] = "eqref";
  TypeKind2[TypeKind2["optref"] = -20] = "optref";
  TypeKind2[TypeKind2["ref"] = -21] = "ref";
  TypeKind2[TypeKind2["i31ref"] = -22] = "i31ref";
  TypeKind2[TypeKind2["rtt_d"] = -23] = "rtt_d";
  TypeKind2[TypeKind2["rtt"] = -24] = "rtt";
  TypeKind2[TypeKind2["dataref"] = -25] = "dataref";
  TypeKind2[TypeKind2["func"] = -32] = "func";
  TypeKind2[TypeKind2["struct"] = -33] = "struct";
  TypeKind2[TypeKind2["array"] = -34] = "array";
  TypeKind2[TypeKind2["func_subtype"] = -35] = "func_subtype";
  TypeKind2[TypeKind2["struct_subtype"] = -36] = "struct_subtype";
  TypeKind2[TypeKind2["array_subtype"] = -37] = "array_subtype";
  TypeKind2[TypeKind2["empty_block_type"] = -64] = "empty_block_type";
})(TypeKind || (TypeKind = {}));
var Type = class {
  constructor(kind, index = -1, depth = -1) {
    if (kind < 0 || kind === 0 && index >= 0) {
    } else {
      throw new Error(`invalid type: ${kind}/${index}/${depth}`);
    }
    this.kind = kind;
    this.index = index;
    this.depth = depth;
    if (index === -16 && kind === -20 || index === -17 && kind === -20 || index === -18 && kind === -20 || index === -19 && kind === -20 || index === -22 && kind === -21 || index === -25 && kind === -21) {
      this.kind = index;
      this.index = -1;
    }
  }
};
Type.funcref = new Type(
  -16
  /* funcref */
);
Type.externref = new Type(
  -17
  /* externref */
);
var RelocType;
(function(RelocType2) {
  RelocType2[RelocType2["FunctionIndex_LEB"] = 0] = "FunctionIndex_LEB";
  RelocType2[RelocType2["TableIndex_SLEB"] = 1] = "TableIndex_SLEB";
  RelocType2[RelocType2["TableIndex_I32"] = 2] = "TableIndex_I32";
  RelocType2[RelocType2["GlobalAddr_LEB"] = 3] = "GlobalAddr_LEB";
  RelocType2[RelocType2["GlobalAddr_SLEB"] = 4] = "GlobalAddr_SLEB";
  RelocType2[RelocType2["GlobalAddr_I32"] = 5] = "GlobalAddr_I32";
  RelocType2[RelocType2["TypeIndex_LEB"] = 6] = "TypeIndex_LEB";
  RelocType2[RelocType2["GlobalIndex_LEB"] = 7] = "GlobalIndex_LEB";
})(RelocType || (RelocType = {}));
var LinkingType;
(function(LinkingType2) {
  LinkingType2[LinkingType2["StackPointer"] = 1] = "StackPointer";
})(LinkingType || (LinkingType = {}));
var NameType;
(function(NameType2) {
  NameType2[NameType2["Module"] = 0] = "Module";
  NameType2[NameType2["Function"] = 1] = "Function";
  NameType2[NameType2["Local"] = 2] = "Local";
  NameType2[NameType2["Event"] = 3] = "Event";
  NameType2[NameType2["Type"] = 4] = "Type";
  NameType2[NameType2["Table"] = 5] = "Table";
  NameType2[NameType2["Memory"] = 6] = "Memory";
  NameType2[NameType2["Global"] = 7] = "Global";
  NameType2[NameType2["Field"] = 10] = "Field";
})(NameType || (NameType = {}));
var BinaryReaderState;
(function(BinaryReaderState2) {
  BinaryReaderState2[BinaryReaderState2["ERROR"] = -1] = "ERROR";
  BinaryReaderState2[BinaryReaderState2["INITIAL"] = 0] = "INITIAL";
  BinaryReaderState2[BinaryReaderState2["BEGIN_WASM"] = 1] = "BEGIN_WASM";
  BinaryReaderState2[BinaryReaderState2["END_WASM"] = 2] = "END_WASM";
  BinaryReaderState2[BinaryReaderState2["BEGIN_SECTION"] = 3] = "BEGIN_SECTION";
  BinaryReaderState2[BinaryReaderState2["END_SECTION"] = 4] = "END_SECTION";
  BinaryReaderState2[BinaryReaderState2["SKIPPING_SECTION"] = 5] = "SKIPPING_SECTION";
  BinaryReaderState2[BinaryReaderState2["READING_SECTION_RAW_DATA"] = 6] = "READING_SECTION_RAW_DATA";
  BinaryReaderState2[BinaryReaderState2["SECTION_RAW_DATA"] = 7] = "SECTION_RAW_DATA";
  BinaryReaderState2[BinaryReaderState2["TYPE_SECTION_ENTRY"] = 11] = "TYPE_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["IMPORT_SECTION_ENTRY"] = 12] = "IMPORT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["FUNCTION_SECTION_ENTRY"] = 13] = "FUNCTION_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["TABLE_SECTION_ENTRY"] = 14] = "TABLE_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["MEMORY_SECTION_ENTRY"] = 15] = "MEMORY_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["GLOBAL_SECTION_ENTRY"] = 16] = "GLOBAL_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["EXPORT_SECTION_ENTRY"] = 17] = "EXPORT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["DATA_SECTION_ENTRY"] = 18] = "DATA_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["NAME_SECTION_ENTRY"] = 19] = "NAME_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["ELEMENT_SECTION_ENTRY"] = 20] = "ELEMENT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["LINKING_SECTION_ENTRY"] = 21] = "LINKING_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["START_SECTION_ENTRY"] = 22] = "START_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["EVENT_SECTION_ENTRY"] = 23] = "EVENT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["BEGIN_INIT_EXPRESSION_BODY"] = 25] = "BEGIN_INIT_EXPRESSION_BODY";
  BinaryReaderState2[BinaryReaderState2["INIT_EXPRESSION_OPERATOR"] = 26] = "INIT_EXPRESSION_OPERATOR";
  BinaryReaderState2[BinaryReaderState2["END_INIT_EXPRESSION_BODY"] = 27] = "END_INIT_EXPRESSION_BODY";
  BinaryReaderState2[BinaryReaderState2["BEGIN_FUNCTION_BODY"] = 28] = "BEGIN_FUNCTION_BODY";
  BinaryReaderState2[BinaryReaderState2["READING_FUNCTION_HEADER"] = 29] = "READING_FUNCTION_HEADER";
  BinaryReaderState2[BinaryReaderState2["CODE_OPERATOR"] = 30] = "CODE_OPERATOR";
  BinaryReaderState2[BinaryReaderState2["END_FUNCTION_BODY"] = 31] = "END_FUNCTION_BODY";
  BinaryReaderState2[BinaryReaderState2["SKIPPING_FUNCTION_BODY"] = 32] = "SKIPPING_FUNCTION_BODY";
  BinaryReaderState2[BinaryReaderState2["BEGIN_ELEMENT_SECTION_ENTRY"] = 33] = "BEGIN_ELEMENT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["ELEMENT_SECTION_ENTRY_BODY"] = 34] = "ELEMENT_SECTION_ENTRY_BODY";
  BinaryReaderState2[BinaryReaderState2["END_ELEMENT_SECTION_ENTRY"] = 35] = "END_ELEMENT_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["BEGIN_DATA_SECTION_ENTRY"] = 36] = "BEGIN_DATA_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["DATA_SECTION_ENTRY_BODY"] = 37] = "DATA_SECTION_ENTRY_BODY";
  BinaryReaderState2[BinaryReaderState2["END_DATA_SECTION_ENTRY"] = 38] = "END_DATA_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["BEGIN_GLOBAL_SECTION_ENTRY"] = 39] = "BEGIN_GLOBAL_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["END_GLOBAL_SECTION_ENTRY"] = 40] = "END_GLOBAL_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["RELOC_SECTION_HEADER"] = 41] = "RELOC_SECTION_HEADER";
  BinaryReaderState2[BinaryReaderState2["RELOC_SECTION_ENTRY"] = 42] = "RELOC_SECTION_ENTRY";
  BinaryReaderState2[BinaryReaderState2["SOURCE_MAPPING_URL"] = 43] = "SOURCE_MAPPING_URL";
  BinaryReaderState2[BinaryReaderState2["BEGIN_OFFSET_EXPRESSION_BODY"] = 44] = "BEGIN_OFFSET_EXPRESSION_BODY";
  BinaryReaderState2[BinaryReaderState2["OFFSET_EXPRESSION_OPERATOR"] = 45] = "OFFSET_EXPRESSION_OPERATOR";
  BinaryReaderState2[BinaryReaderState2["END_OFFSET_EXPRESSION_BODY"] = 46] = "END_OFFSET_EXPRESSION_BODY";
})(BinaryReaderState || (BinaryReaderState = {}));
var DataSegmentType;
(function(DataSegmentType2) {
  DataSegmentType2[DataSegmentType2["Active"] = 0] = "Active";
  DataSegmentType2[DataSegmentType2["Passive"] = 1] = "Passive";
  DataSegmentType2[DataSegmentType2["ActiveWithMemoryIndex"] = 2] = "ActiveWithMemoryIndex";
})(DataSegmentType || (DataSegmentType = {}));
function isActiveDataSegmentType(segmentType) {
  switch (segmentType) {
    case 0:
    case 2:
      return true;
    default:
      return false;
  }
}
var DataMode;
(function(DataMode2) {
  DataMode2[DataMode2["Active"] = 0] = "Active";
  DataMode2[DataMode2["Passive"] = 1] = "Passive";
})(DataMode || (DataMode = {}));
var ElementSegmentType;
(function(ElementSegmentType2) {
  ElementSegmentType2[ElementSegmentType2["LegacyActiveFuncrefExternval"] = 0] = "LegacyActiveFuncrefExternval";
  ElementSegmentType2[ElementSegmentType2["PassiveExternval"] = 1] = "PassiveExternval";
  ElementSegmentType2[ElementSegmentType2["ActiveExternval"] = 2] = "ActiveExternval";
  ElementSegmentType2[ElementSegmentType2["DeclaredExternval"] = 3] = "DeclaredExternval";
  ElementSegmentType2[ElementSegmentType2["LegacyActiveFuncrefElemexpr"] = 4] = "LegacyActiveFuncrefElemexpr";
  ElementSegmentType2[ElementSegmentType2["PassiveElemexpr"] = 5] = "PassiveElemexpr";
  ElementSegmentType2[ElementSegmentType2["ActiveElemexpr"] = 6] = "ActiveElemexpr";
  ElementSegmentType2[ElementSegmentType2["DeclaredElemexpr"] = 7] = "DeclaredElemexpr";
})(ElementSegmentType || (ElementSegmentType = {}));
function isActiveElementSegmentType(segmentType) {
  switch (segmentType) {
    case 0:
    case 2:
    case 4:
    case 6:
      return true;
    default:
      return false;
  }
}
function isExternvalElementSegmentType(segmentType) {
  switch (segmentType) {
    case 0:
    case 1:
    case 2:
    case 3:
      return true;
    default:
      return false;
  }
}
var ElementMode;
(function(ElementMode2) {
  ElementMode2[ElementMode2["Active"] = 0] = "Active";
  ElementMode2[ElementMode2["Passive"] = 1] = "Passive";
  ElementMode2[ElementMode2["Declarative"] = 2] = "Declarative";
})(ElementMode || (ElementMode = {}));
var DataRange = class {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
  offset(delta) {
    this.start += delta;
    this.end += delta;
  }
};
var Int64 = class {
  constructor(data) {
    this._data = data || new Uint8Array(8);
  }
  toInt32() {
    return this._data[0] | this._data[1] << 8 | this._data[2] << 16 | this._data[3] << 24;
  }
  toDouble() {
    var power = 1;
    var sum;
    if (this._data[7] & 128) {
      sum = -1;
      for (var i = 0; i < 8; i++, power *= 256)
        sum -= power * (255 ^ this._data[i]);
    } else {
      sum = 0;
      for (var i = 0; i < 8; i++, power *= 256)
        sum += power * this._data[i];
    }
    return sum;
  }
  toString() {
    var low = (this._data[0] | this._data[1] << 8 | this._data[2] << 16 | this._data[3] << 24) >>> 0;
    var high = (this._data[4] | this._data[5] << 8 | this._data[6] << 16 | this._data[7] << 24) >>> 0;
    if (low === 0 && high === 0) {
      return "0";
    }
    var sign = false;
    if (high >> 31) {
      high = 4294967296 - high;
      if (low > 0) {
        high--;
        low = 4294967296 - low;
      }
      sign = true;
    }
    var buf = [];
    while (high > 0) {
      var t = high % 10 * 4294967296 + low;
      high = Math.floor(high / 10);
      buf.unshift((t % 10).toString());
      low = Math.floor(t / 10);
    }
    while (low > 0) {
      buf.unshift((low % 10).toString());
      low = Math.floor(low / 10);
    }
    if (sign)
      buf.unshift("-");
    return buf.join("");
  }
  get data() {
    return this._data;
  }
};
var BinaryReader = class {
  constructor() {
    this._data = null;
    this._pos = 0;
    this._length = 0;
    this._eof = false;
    this.state = 0;
    this.result = null;
    this.error = null;
    this._sectionEntriesLeft = 0;
    this._sectionId = -1;
    this._sectionRange = null;
    this._functionRange = null;
    this._segmentType = 0;
    this._segmentEntriesLeft = 0;
  }
  get data() {
    return this._data;
  }
  get position() {
    return this._pos;
  }
  get length() {
    return this._length;
  }
  setData(buffer, pos, length, eof) {
    var posDelta = pos - this._pos;
    this._data = new Uint8Array(buffer);
    this._pos = pos;
    this._length = length;
    this._eof = eof === void 0 ? true : eof;
    if (this._sectionRange)
      this._sectionRange.offset(posDelta);
    if (this._functionRange)
      this._functionRange.offset(posDelta);
  }
  hasBytes(n) {
    return this._pos + n <= this._length;
  }
  hasMoreBytes() {
    return this.hasBytes(1);
  }
  readUint8() {
    return this._data[this._pos++];
  }
  readInt32() {
    var b1 = this._data[this._pos++];
    var b2 = this._data[this._pos++];
    var b3 = this._data[this._pos++];
    var b4 = this._data[this._pos++];
    return b1 | b2 << 8 | b3 << 16 | b4 << 24;
  }
  readUint32() {
    return this.readInt32();
  }
  peekInt32() {
    var b1 = this._data[this._pos];
    var b2 = this._data[this._pos + 1];
    var b3 = this._data[this._pos + 2];
    var b4 = this._data[this._pos + 3];
    return b1 | b2 << 8 | b3 << 16 | b4 << 24;
  }
  hasVarIntBytes() {
    var pos = this._pos;
    while (pos < this._length) {
      if ((this._data[pos++] & 128) == 0)
        return true;
    }
    return false;
  }
  readVarUint1() {
    return this.readUint8();
  }
  readVarInt7() {
    return this.readUint8() << 25 >> 25;
  }
  readVarUint7() {
    return this.readUint8();
  }
  readVarInt32() {
    var result = 0;
    var shift = 0;
    while (true) {
      var byte = this.readUint8();
      result |= (byte & 127) << shift;
      shift += 7;
      if ((byte & 128) === 0)
        break;
    }
    if (shift >= 32)
      return result;
    var ashift = 32 - shift;
    return result << ashift >> ashift;
  }
  readVarUint32() {
    var result = 0;
    var shift = 0;
    while (true) {
      var byte = this.readUint8();
      result |= (byte & 127) << shift;
      shift += 7;
      if ((byte & 128) === 0)
        break;
    }
    return result >>> 0;
  }
  readVarInt64() {
    var result = new Uint8Array(8);
    var i = 0;
    var c = 0;
    var shift = 0;
    while (true) {
      var byte = this.readUint8();
      c |= (byte & 127) << shift;
      shift += 7;
      if (shift > 8) {
        result[i++] = c & 255;
        c >>= 8;
        shift -= 8;
      }
      if ((byte & 128) === 0)
        break;
    }
    var ashift = 32 - shift;
    c = c << ashift >> ashift;
    while (i < 8) {
      result[i++] = c & 255;
      c >>= 8;
    }
    return new Int64(result);
  }
  // Reads any "s33" (signed 33-bit integer) value correctly; no guarantees
  // outside that range.
  readHeapType() {
    var result = 0;
    var shift = 0;
    var byte;
    while (true) {
      byte = this.readUint8();
      if (shift === 28) {
        var signed = byte << 25 >> 25;
        return signed * Math.pow(2, 28) + result;
      }
      result |= (byte & 127) << shift;
      shift += 7;
      if ((byte & 128) === 0)
        break;
    }
    shift = 32 - shift;
    return result << shift >> shift;
  }
  readTypeInternal(kind) {
    if (kind === -21 || kind === -20 || kind === -24) {
      var index = this.readHeapType();
      return new Type(kind, index);
    }
    if (kind === -23) {
      var index = this.readHeapType();
      var depth = this.readVarUint32();
      return new Type(kind, index, depth);
    }
    return new Type(kind);
  }
  readType() {
    var kind = this.readVarInt7();
    return this.readTypeInternal(kind);
  }
  readBlockType() {
    var block_type = this.readHeapType();
    if (block_type < 0) {
      return this.readTypeInternal(block_type);
    }
    var func_index = block_type;
    return new Type(0, func_index);
  }
  readStringBytes() {
    var length = this.readVarUint32();
    return this.readBytes(length);
  }
  readBytes(length) {
    var result = this._data.subarray(this._pos, this._pos + length);
    this._pos += length;
    return new Uint8Array(result);
  }
  skipBytes(length) {
    this._pos += length;
  }
  hasStringBytes() {
    if (!this.hasVarIntBytes())
      return false;
    var pos = this._pos;
    var length = this.readVarUint32();
    var result = this.hasBytes(length);
    this._pos = pos;
    return result;
  }
  hasSectionPayload() {
    return this.hasBytes(this._sectionRange.end - this._pos);
  }
  readFuncType() {
    var paramCount = this.readVarUint32();
    var paramTypes = new Array(paramCount);
    for (var i = 0; i < paramCount; i++)
      paramTypes[i] = this.readType();
    var returnCount = this.readVarUint1();
    var returnTypes = new Array(returnCount);
    for (var i = 0; i < returnCount; i++)
      returnTypes[i] = this.readType();
    return {
      form: -32,
      params: paramTypes,
      returns: returnTypes
    };
  }
  readFuncSubtype() {
    var result = this.readFuncType();
    result.form = -35;
    result.supertype = this.readHeapType();
    return result;
  }
  readStructType() {
    var fieldCount = this.readVarUint32();
    var fieldTypes = new Array(fieldCount);
    var fieldMutabilities = new Array(fieldCount);
    for (var i = 0; i < fieldCount; i++) {
      fieldTypes[i] = this.readType();
      fieldMutabilities[i] = !!this.readVarUint1();
    }
    return {
      form: -33,
      fields: fieldTypes,
      mutabilities: fieldMutabilities
    };
  }
  readStructSubtype() {
    var result = this.readStructType();
    result.form = -36;
    result.supertype = this.readHeapType();
    return result;
  }
  readArrayType() {
    var elementType = this.readType();
    var mutability = !!this.readVarUint1();
    return {
      form: -34,
      elementType,
      mutability
    };
  }
  readArraySubtype() {
    var result = this.readArrayType();
    result.form = -37;
    result.supertype = this.readHeapType();
    return result;
  }
  readResizableLimits(maxPresent) {
    var initial = this.readVarUint32();
    var maximum;
    if (maxPresent) {
      maximum = this.readVarUint32();
    }
    return { initial, maximum };
  }
  readTableType() {
    var elementType = this.readType();
    var flags = this.readVarUint32();
    var limits = this.readResizableLimits(!!(flags & 1));
    return { elementType, limits };
  }
  readMemoryType() {
    var flags = this.readVarUint32();
    var shared = !!(flags & 2);
    return {
      limits: this.readResizableLimits(!!(flags & 1)),
      shared
    };
  }
  readGlobalType() {
    if (!this.hasVarIntBytes()) {
      return null;
    }
    var pos = this._pos;
    var contentType = this.readType();
    if (!this.hasVarIntBytes()) {
      this._pos = pos;
      return null;
    }
    var mutability = this.readVarUint1();
    return { contentType, mutability };
  }
  readEventType() {
    var attribute = this.readVarUint32();
    var typeIndex = this.readVarUint32();
    return {
      attribute,
      typeIndex
    };
  }
  readTypeEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    this.state = 11;
    var form = this.readVarInt7();
    switch (form) {
      case -32:
        this.result = this.readFuncType();
        break;
      case -35:
        this.result = this.readFuncSubtype();
        break;
      case -33:
        this.result = this.readStructType();
        break;
      case -36:
        this.result = this.readStructSubtype();
        break;
      case -34:
        this.result = this.readArrayType();
        break;
      case -37:
        this.result = this.readArraySubtype();
        break;
      default:
        throw new Error(`Unknown type kind: ${form}`);
    }
    this._sectionEntriesLeft--;
    return true;
  }
  readImportEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    this.state = 12;
    var module = this.readStringBytes();
    var field = this.readStringBytes();
    var kind = this.readUint8();
    var funcTypeIndex;
    var type;
    switch (kind) {
      case 0:
        funcTypeIndex = this.readVarUint32();
        break;
      case 1:
        type = this.readTableType();
        break;
      case 2:
        type = this.readMemoryType();
        break;
      case 3:
        type = this.readGlobalType();
        break;
      case 4:
        type = this.readEventType();
        break;
    }
    this.result = {
      module,
      field,
      kind,
      funcTypeIndex,
      type
    };
    this._sectionEntriesLeft--;
    return true;
  }
  readExportEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    var field = this.readStringBytes();
    var kind = this.readUint8();
    var index = this.readVarUint32();
    this.state = 17;
    this.result = { field, kind, index };
    this._sectionEntriesLeft--;
    return true;
  }
  readFunctionEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    var typeIndex = this.readVarUint32();
    this.state = 13;
    this.result = { typeIndex };
    this._sectionEntriesLeft--;
    return true;
  }
  readTableEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    this.state = 14;
    this.result = this.readTableType();
    this._sectionEntriesLeft--;
    return true;
  }
  readMemoryEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    this.state = 15;
    this.result = this.readMemoryType();
    this._sectionEntriesLeft--;
    return true;
  }
  readEventEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    this.state = 23;
    this.result = this.readEventType();
    this._sectionEntriesLeft--;
    return true;
  }
  readGlobalEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    var globalType = this.readGlobalType();
    if (!globalType) {
      this.state = 16;
      return false;
    }
    this.state = 39;
    this.result = {
      type: globalType
    };
    this._sectionEntriesLeft--;
    return true;
  }
  readElementEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    const pos = this._pos;
    if (!this.hasMoreBytes()) {
      this.state = 20;
      return false;
    }
    const segmentType = this.readUint8();
    let mode, tableIndex;
    switch (segmentType) {
      case 0:
      case 4:
        mode = 0;
        tableIndex = 0;
        break;
      case 1:
      case 5:
        mode = 1;
        break;
      case 2:
      case 6:
        mode = 0;
        if (!this.hasVarIntBytes()) {
          this.state = 20;
          this._pos = pos;
          return false;
        }
        tableIndex = this.readVarUint32();
        break;
      case 3:
      case 7:
        mode = 2;
        break;
      default:
        throw new Error(`Unsupported element segment type ${segmentType}`);
    }
    this.state = 33;
    this.result = { mode, tableIndex };
    this._sectionEntriesLeft--;
    this._segmentType = segmentType;
    return true;
  }
  readElementEntryBody() {
    let elementType = Type.funcref;
    switch (this._segmentType) {
      case 1:
      case 2:
      case 3:
        if (!this.hasMoreBytes())
          return false;
        this.skipBytes(1);
        break;
      case 5:
      case 6:
      case 7:
        if (!this.hasMoreBytes())
          return false;
        elementType = this.readType();
        break;
      case 0:
      case 4:
        break;
      default:
        throw new Error(`Unsupported element segment type ${this._segmentType}`);
    }
    this.state = 34;
    this.result = { elementType };
    return true;
  }
  readDataEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    const pos = this._pos;
    if (!this.hasVarIntBytes()) {
      this.state = 18;
      return false;
    }
    const segmentType = this.readVarUint32();
    let mode, memoryIndex;
    switch (segmentType) {
      case 0:
        mode = 0;
        memoryIndex = 0;
        break;
      case 1:
        mode = 1;
        break;
      case 2:
        mode = 0;
        if (!this.hasVarIntBytes()) {
          this._pos = pos;
          this.state = 18;
          return false;
        }
        memoryIndex = this.readVarUint32();
        break;
      default:
        throw new Error(`Unsupported data segment type ${segmentType}`);
    }
    this.state = 36;
    this.result = { mode, memoryIndex };
    this._sectionEntriesLeft--;
    this._segmentType = segmentType;
    return true;
  }
  readDataEntryBody() {
    if (!this.hasStringBytes()) {
      return false;
    }
    this.state = 37;
    this.result = {
      data: this.readStringBytes()
    };
    return true;
  }
  readInitExpressionBody() {
    this.state = 25;
    this.result = null;
    return true;
  }
  readOffsetExpressionBody() {
    this.state = 44;
    this.result = null;
    return true;
  }
  readMemoryImmediate() {
    var flags = this.readVarUint32();
    var offset = this.readVarUint32();
    return { flags, offset };
  }
  readNameMap() {
    var count = this.readVarUint32();
    var result = [];
    for (var i = 0; i < count; i++) {
      var index = this.readVarUint32();
      var name = this.readStringBytes();
      result.push({ index, name });
    }
    return result;
  }
  readNameEntry() {
    var pos = this._pos;
    if (pos >= this._sectionRange.end) {
      this.skipSection();
      return this.read();
    }
    if (!this.hasVarIntBytes())
      return false;
    var type = this.readVarUint7();
    if (!this.hasVarIntBytes()) {
      this._pos = pos;
      return false;
    }
    var payloadLength = this.readVarUint32();
    if (!this.hasBytes(payloadLength)) {
      this._pos = pos;
      return false;
    }
    var result;
    switch (type) {
      case 0:
        result = {
          type,
          moduleName: this.readStringBytes()
        };
        break;
      case 1:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        result = {
          type,
          names: this.readNameMap()
        };
        break;
      case 2:
        var funcsLength = this.readVarUint32();
        var funcs = [];
        for (var i = 0; i < funcsLength; i++) {
          var funcIndex = this.readVarUint32();
          funcs.push({
            index: funcIndex,
            locals: this.readNameMap()
          });
        }
        result = {
          type,
          funcs
        };
        break;
      case 10:
        var typesLength = this.readVarUint32();
        var types = [];
        for (var i = 0; i < typesLength; i++) {
          var fieldIndex = this.readVarUint32();
          types.push({
            index: fieldIndex,
            fields: this.readNameMap()
          });
        }
        result = {
          type,
          types
        };
        break;
      default:
        this.skipBytes(payloadLength);
        return this.read();
    }
    this.state = 19;
    this.result = result;
    return true;
  }
  readRelocHeader() {
    if (!this.hasVarIntBytes()) {
      return false;
    }
    var pos = this._pos;
    var sectionId = this.readVarUint7();
    var sectionName;
    if (sectionId === 0) {
      if (!this.hasStringBytes()) {
        this._pos = pos;
        return false;
      }
      sectionName = this.readStringBytes();
    }
    this.state = 41;
    this.result = {
      id: sectionId,
      name: sectionName
    };
    return true;
  }
  readLinkingEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    if (!this.hasVarIntBytes())
      return false;
    var pos = this._pos;
    var type = this.readVarUint32();
    var index;
    switch (type) {
      case 1:
        if (!this.hasVarIntBytes()) {
          this._pos = pos;
          return false;
        }
        index = this.readVarUint32();
        break;
      default:
        this.error = new Error(`Bad linking type: ${type}`);
        this.state = -1;
        return true;
    }
    this.state = 21;
    this.result = { type, index };
    this._sectionEntriesLeft--;
    return true;
  }
  readSourceMappingURL() {
    if (!this.hasStringBytes())
      return false;
    var url = this.readStringBytes();
    this.state = 43;
    this.result = { url };
    return true;
  }
  readRelocEntry() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    if (!this.hasVarIntBytes())
      return false;
    var pos = this._pos;
    var type = this.readVarUint7();
    if (!this.hasVarIntBytes()) {
      this._pos = pos;
      return false;
    }
    var offset = this.readVarUint32();
    if (!this.hasVarIntBytes()) {
      this._pos = pos;
      return false;
    }
    var index = this.readVarUint32();
    var addend;
    switch (type) {
      case 0:
      case 1:
      case 2:
      case 6:
      case 7:
        break;
      case 3:
      case 4:
      case 5:
        if (!this.hasVarIntBytes()) {
          this._pos = pos;
          return false;
        }
        addend = this.readVarUint32();
        break;
      default:
        this.error = new Error(`Bad relocation type: ${type}`);
        this.state = -1;
        return true;
    }
    this.state = 42;
    this.result = {
      type,
      offset,
      index,
      addend
    };
    this._sectionEntriesLeft--;
    return true;
  }
  readCodeOperator_0xfb() {
    const MAX_CODE_OPERATOR_0XFB_SIZE = 12;
    if (!this._eof && !this.hasBytes(MAX_CODE_OPERATOR_0XFB_SIZE)) {
      return false;
    }
    var code, brDepth, refType, srcType, fieldIndex;
    code = this._data[this._pos++] | 64256;
    switch (code) {
      case 64322:
      case 64323:
      case 64352:
      case 64355:
      case 64353:
      case 64356:
      case 64354:
      case 64357:
        brDepth = this.readVarUint32();
        break;
      case 64326:
      case 64327:
        brDepth = this.readVarUint32();
        refType = this.readHeapType();
        break;
      case 64275:
      case 64276:
      case 64277:
      case 64279:
      case 64278:
      case 64283:
      case 64273:
      case 64284:
      case 64274:
      case 64263:
      case 64257:
      case 64264:
      case 64258:
      case 64304:
      case 64305:
      case 64306:
      case 64324:
      case 64325:
        refType = this.readHeapType();
        break;
      case 64280:
        refType = this.readHeapType();
        srcType = this.readHeapType();
        break;
      case 64259:
      case 64260:
      case 64261:
      case 64262:
        refType = this.readHeapType();
        fieldIndex = this.readVarUint32();
        break;
      case 64281:
      case 64282:
        refType = this.readHeapType();
        brDepth = this.readVarUint32();
        break;
      case 64336:
      case 64337:
      case 64338:
      case 64344:
      case 64345:
      case 64346:
      case 64320:
      case 64321:
      case 64288:
      case 64289:
      case 64290:
        break;
      default:
        this.error = new Error(`Unknown operator: 0x${code.toString(16).padStart(4, "0")}`);
        this.state = -1;
        return true;
    }
    this.result = {
      code,
      blockType: void 0,
      refType,
      srcType,
      brDepth,
      brTable: void 0,
      tableIndex: void 0,
      funcIndex: void 0,
      typeIndex: void 0,
      localIndex: void 0,
      globalIndex: void 0,
      fieldIndex,
      memoryAddress: void 0,
      literal: void 0,
      segmentIndex: void 0,
      destinationIndex: void 0,
      lines: void 0,
      lineIndex: void 0
    };
    return true;
  }
  readCodeOperator_0xfc() {
    if (!this.hasVarIntBytes()) {
      return false;
    }
    var code = this.readVarUint32() | 64512;
    var reserved, segmentIndex, destinationIndex, tableIndex;
    switch (code) {
      case 64512:
      case 64513:
      case 64514:
      case 64515:
      case 64516:
      case 64517:
      case 64518:
      case 64519:
        break;
      case 64522:
        reserved = this.readVarUint1();
        reserved = this.readVarUint1();
        break;
      case 64523:
        reserved = this.readVarUint1();
        break;
      case 64524:
        segmentIndex = this.readVarUint32();
        tableIndex = this.readVarUint32();
        break;
      case 64526:
        tableIndex = this.readVarUint32();
        destinationIndex = this.readVarUint32();
        break;
      case 64527:
      case 64528:
      case 64529:
        tableIndex = this.readVarUint32();
        break;
      case 64520:
        segmentIndex = this.readVarUint32();
        reserved = this.readVarUint1();
        break;
      case 64521:
      case 64525:
        segmentIndex = this.readVarUint32();
        break;
      default:
        this.error = new Error(`Unknown operator: 0x${code.toString(16).padStart(4, "0")}`);
        this.state = -1;
        return true;
    }
    this.result = {
      code,
      blockType: void 0,
      selectType: void 0,
      refType: void 0,
      srcType: void 0,
      brDepth: void 0,
      brTable: void 0,
      funcIndex: void 0,
      typeIndex: void 0,
      tableIndex,
      localIndex: void 0,
      globalIndex: void 0,
      fieldIndex: void 0,
      memoryAddress: void 0,
      literal: void 0,
      segmentIndex,
      destinationIndex,
      lines: void 0,
      lineIndex: void 0
    };
    return true;
  }
  readCodeOperator_0xfd() {
    const MAX_CODE_OPERATOR_0XFD_SIZE = 17;
    var pos = this._pos;
    if (!this._eof && pos + MAX_CODE_OPERATOR_0XFD_SIZE > this._length) {
      return false;
    }
    if (!this.hasVarIntBytes()) {
      return false;
    }
    var code = this.readVarUint32() | 64768;
    var memoryAddress;
    var literal;
    var lineIndex;
    var lines;
    switch (code) {
      case 64768:
      case 64769:
      case 64770:
      case 64771:
      case 64772:
      case 64773:
      case 64774:
      case 64775:
      case 64776:
      case 64777:
      case 64778:
      case 64779:
      case 64860:
      case 64861:
        memoryAddress = this.readMemoryImmediate();
        break;
      case 64780:
        literal = this.readBytes(16);
        break;
      case 64781:
        lines = new Uint8Array(16);
        for (var i = 0; i < lines.length; i++) {
          lines[i] = this.readUint8();
        }
        break;
      case 64789:
      case 64790:
      case 64791:
      case 64792:
      case 64793:
      case 64794:
      case 64795:
      case 64796:
      case 64797:
      case 64798:
      case 64799:
      case 64800:
      case 64801:
      case 64802:
        lineIndex = this.readUint8();
        break;
      case 64782:
      case 64783:
      case 64784:
      case 64785:
      case 64786:
      case 64787:
      case 64788:
      case 64803:
      case 64804:
      case 64805:
      case 64806:
      case 64807:
      case 64808:
      case 64809:
      case 64810:
      case 64811:
      case 64812:
      case 64813:
      case 64814:
      case 64815:
      case 64816:
      case 64817:
      case 64818:
      case 64819:
      case 64820:
      case 64821:
      case 64822:
      case 64823:
      case 64824:
      case 64825:
      case 64826:
      case 64827:
      case 64828:
      case 64829:
      case 64830:
      case 64831:
      case 64832:
      case 64833:
      case 64834:
      case 64835:
      case 64836:
      case 64837:
      case 64838:
      case 64839:
      case 64840:
      case 64841:
      case 64842:
      case 64843:
      case 64844:
      case 64845:
      case 64846:
      case 64847:
      case 64848:
      case 64849:
      case 64850:
      case 64851:
      case 64862:
      case 64863:
      case 64864:
      case 64865:
      case 64866:
      case 64867:
      case 64868:
      case 64869:
      case 64870:
      case 64871:
      case 64872:
      case 64873:
      case 64874:
      case 64875:
      case 64876:
      case 64877:
      case 64878:
      case 64879:
      case 64880:
      case 64881:
      case 64882:
      case 64883:
      case 64884:
      case 64885:
      case 64886:
      case 64887:
      case 64888:
      case 64889:
      case 64890:
      case 64891:
      case 64892:
      case 64893:
      case 64894:
      case 64895:
      case 64896:
      case 64897:
      case 64898:
      case 64899:
      case 64900:
      case 64901:
      case 64902:
      case 64903:
      case 64904:
      case 64905:
      case 64906:
      case 64907:
      case 64908:
      case 64909:
      case 64910:
      case 64911:
      case 64912:
      case 64913:
      case 64914:
      case 64915:
      case 64916:
      case 64917:
      case 64918:
      case 64919:
      case 64920:
      case 64921:
      case 64923:
      case 64924:
      case 64925:
      case 64926:
      case 64927:
      case 64928:
      case 64929:
      case 64931:
      case 64932:
      case 64935:
      case 64936:
      case 64937:
      case 64938:
      case 64939:
      case 64940:
      case 64941:
      case 64942:
      case 64945:
      case 64949:
      case 64950:
      case 64951:
      case 64952:
      case 64953:
      case 64954:
      case 64956:
      case 64957:
      case 64958:
      case 64959:
      case 64960:
      case 64961:
      case 64963:
      case 64964:
      case 64967:
      case 64968:
      case 64969:
      case 64970:
      case 64971:
      case 64972:
      case 64973:
      case 64974:
      case 64977:
      case 64981:
      case 64982:
      case 64983:
      case 64984:
      case 64985:
      case 64986:
      case 64987:
      case 64988:
      case 64989:
      case 64988:
      case 64989:
      case 64992:
      case 64992:
      case 64993:
      case 64995:
      case 64996:
      case 64997:
      case 64998:
      case 64999:
      case 65e3:
      case 65001:
      case 65002:
      case 65003:
      case 65004:
      case 65005:
      case 65007:
      case 65008:
      case 65009:
      case 65010:
      case 65011:
      case 65012:
      case 65013:
      case 65014:
      case 65015:
      case 65016:
      case 65017:
      case 65018:
      case 65019:
      case 65020:
      case 65021:
      case 65022:
      case 65023:
        break;
      default:
        this.error = new Error(`Unknown operator: 0x${code.toString(16).padStart(4, "0")}`);
        this.state = -1;
        return true;
    }
    this.result = {
      code,
      blockType: void 0,
      selectType: void 0,
      refType: void 0,
      srcType: void 0,
      brDepth: void 0,
      brTable: void 0,
      funcIndex: void 0,
      typeIndex: void 0,
      localIndex: void 0,
      globalIndex: void 0,
      fieldIndex: void 0,
      memoryAddress,
      literal,
      segmentIndex: void 0,
      destinationIndex: void 0,
      lines,
      lineIndex
    };
    return true;
  }
  readCodeOperator_0xfe() {
    const MAX_CODE_OPERATOR_0XFE_SIZE = 11;
    var pos = this._pos;
    if (!this._eof && pos + MAX_CODE_OPERATOR_0XFE_SIZE > this._length) {
      return false;
    }
    if (!this.hasVarIntBytes()) {
      return false;
    }
    var code = this.readVarUint32() | 65024;
    var memoryAddress;
    switch (code) {
      case 65024:
      case 65025:
      case 65026:
      case 65040:
      case 65041:
      case 65042:
      case 65043:
      case 65044:
      case 65045:
      case 65046:
      case 65047:
      case 65048:
      case 65049:
      case 65050:
      case 65051:
      case 65052:
      case 65053:
      case 65054:
      case 65055:
      case 65056:
      case 65057:
      case 65058:
      case 65059:
      case 65060:
      case 65061:
      case 65062:
      case 65063:
      case 65064:
      case 65065:
      case 65066:
      case 65067:
      case 65068:
      case 65069:
      case 65070:
      case 65071:
      case 65072:
      case 65073:
      case 65074:
      case 65075:
      case 65076:
      case 65077:
      case 65078:
      case 65079:
      case 65080:
      case 65081:
      case 65082:
      case 65083:
      case 65084:
      case 65085:
      case 65086:
      case 65087:
      case 65088:
      case 65089:
      case 65090:
      case 65091:
      case 65092:
      case 65093:
      case 65094:
      case 65095:
      case 65096:
      case 65097:
      case 65098:
      case 65099:
      case 65100:
      case 65101:
      case 65102:
        memoryAddress = this.readMemoryImmediate();
        break;
      case 65027: {
        var consistency_model = this.readUint8();
        if (consistency_model != 0) {
          this.error = new Error("atomic.fence consistency model must be 0");
          this.state = -1;
          return true;
        }
        break;
      }
      default:
        this.error = new Error(`Unknown operator: 0x${code.toString(16).padStart(4, "0")}`);
        this.state = -1;
        return true;
    }
    this.result = {
      code,
      blockType: void 0,
      selectType: void 0,
      refType: void 0,
      srcType: void 0,
      brDepth: void 0,
      brTable: void 0,
      funcIndex: void 0,
      typeIndex: void 0,
      localIndex: void 0,
      globalIndex: void 0,
      fieldIndex: void 0,
      memoryAddress,
      literal: void 0,
      segmentIndex: void 0,
      destinationIndex: void 0,
      lines: void 0,
      lineIndex: void 0
    };
    return true;
  }
  readCodeOperator() {
    switch (this.state) {
      case 30:
        if (this._pos >= this._functionRange.end) {
          this.skipFunctionBody();
          return this.read();
        }
        break;
      case 26:
        if (this.result && this.result.code === 11) {
          this.state = 27;
          this.result = null;
          return true;
        }
        break;
      case 45:
        if (this.result && this.result.code === 11) {
          this.state = 46;
          this.result = null;
          return true;
        }
        break;
    }
    var code, blockType, selectType, refType, brDepth, brTable, relativeDepth, funcIndex, typeIndex, tableIndex, localIndex, globalIndex, eventIndex, memoryAddress, literal, reserved;
    if (this.state === 26 && this._sectionId === 9 && isExternvalElementSegmentType(this._segmentType)) {
      if (this.result && this.result.code === 210) {
        code = 11;
      } else {
        if (!this.hasVarIntBytes())
          return false;
        code = 210;
        funcIndex = this.readVarUint32();
      }
    } else {
      const MAX_CODE_OPERATOR_SIZE = 11;
      var pos = this._pos;
      if (!this._eof && pos + MAX_CODE_OPERATOR_SIZE > this._length) {
        return false;
      }
      code = this._data[this._pos++];
      switch (code) {
        case 2:
        case 3:
        case 4:
        case 6:
          blockType = this.readBlockType();
          break;
        case 12:
        case 13:
        case 212:
        case 214:
          brDepth = this.readVarUint32();
          break;
        case 14:
          var tableCount = this.readVarUint32();
          if (!this.hasBytes(tableCount + 1)) {
            this._pos = pos;
            return false;
          }
          brTable = [];
          for (var i = 0; i <= tableCount; i++) {
            if (!this.hasVarIntBytes()) {
              this._pos = pos;
              return false;
            }
            brTable.push(this.readVarUint32());
          }
          break;
        case 9:
        case 24:
          relativeDepth = this.readVarUint32();
          break;
        case 7:
        case 8:
          eventIndex = this.readVarInt32();
          break;
        case 208:
          refType = this.readHeapType();
          break;
        case 16:
        case 18:
        case 210:
          funcIndex = this.readVarUint32();
          break;
        case 17:
        case 19:
          typeIndex = this.readVarUint32();
          reserved = this.readVarUint1();
          break;
        case 32:
        case 33:
        case 34:
          localIndex = this.readVarUint32();
          break;
        case 35:
        case 36:
          globalIndex = this.readVarUint32();
          break;
        case 37:
        case 38:
          tableIndex = this.readVarUint32();
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
        case 48:
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
        case 58:
        case 59:
        case 60:
        case 61:
        case 62:
          memoryAddress = this.readMemoryImmediate();
          break;
        case 63:
        case 64:
          reserved = this.readVarUint1();
          break;
        case 65:
          literal = this.readVarInt32();
          break;
        case 66:
          literal = this.readVarInt64();
          break;
        case 67:
          literal = new DataView(this._data.buffer, this._data.byteOffset).getFloat32(this._pos, true);
          this._pos += 4;
          break;
        case 68:
          literal = new DataView(this._data.buffer, this._data.byteOffset).getFloat64(this._pos, true);
          this._pos += 8;
          break;
        case 28:
          const num_types = this.readVarInt32();
          if (num_types == 1) {
            selectType = this.readType();
          }
          break;
        case 251:
          if (this.readCodeOperator_0xfb()) {
            return true;
          }
          this._pos = pos;
          return false;
        case 252:
          if (this.readCodeOperator_0xfc()) {
            return true;
          }
          this._pos = pos;
          return false;
        case 253:
          if (this.readCodeOperator_0xfd()) {
            return true;
          }
          this._pos = pos;
          return false;
        case 254:
          if (this.readCodeOperator_0xfe()) {
            return true;
          }
          this._pos = pos;
          return false;
        case 0:
        case 1:
        case 5:
        case 10:
        case 11:
        case 15:
        case 25:
        case 26:
        case 27:
        case 69:
        case 70:
        case 71:
        case 72:
        case 73:
        case 74:
        case 75:
        case 76:
        case 77:
        case 78:
        case 79:
        case 80:
        case 81:
        case 82:
        case 83:
        case 84:
        case 85:
        case 86:
        case 87:
        case 88:
        case 89:
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
        case 98:
        case 99:
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
        case 108:
        case 109:
        case 110:
        case 111:
        case 112:
        case 113:
        case 114:
        case 115:
        case 116:
        case 117:
        case 118:
        case 119:
        case 120:
        case 121:
        case 122:
        case 123:
        case 124:
        case 125:
        case 126:
        case 127:
        case 128:
        case 129:
        case 130:
        case 131:
        case 132:
        case 133:
        case 134:
        case 135:
        case 136:
        case 137:
        case 138:
        case 139:
        case 140:
        case 141:
        case 142:
        case 143:
        case 144:
        case 145:
        case 146:
        case 147:
        case 148:
        case 149:
        case 150:
        case 151:
        case 152:
        case 153:
        case 154:
        case 155:
        case 156:
        case 157:
        case 158:
        case 159:
        case 160:
        case 161:
        case 162:
        case 163:
        case 164:
        case 165:
        case 166:
        case 167:
        case 168:
        case 169:
        case 170:
        case 171:
        case 172:
        case 173:
        case 174:
        case 175:
        case 176:
        case 177:
        case 178:
        case 179:
        case 180:
        case 181:
        case 182:
        case 183:
        case 184:
        case 185:
        case 186:
        case 187:
        case 188:
        case 189:
        case 190:
        case 191:
        case 192:
        case 193:
        case 194:
        case 195:
        case 196:
        case 20:
        case 21:
        case 209:
        case 211:
        case 213:
          break;
        default:
          this.error = new Error(`Unknown operator: ${code}`);
          this.state = -1;
          return true;
      }
    }
    this.result = {
      code,
      blockType,
      selectType,
      refType,
      srcType: void 0,
      brDepth,
      brTable,
      relativeDepth,
      tableIndex,
      funcIndex,
      typeIndex,
      localIndex,
      globalIndex,
      fieldIndex: void 0,
      eventIndex,
      memoryAddress,
      literal,
      segmentIndex: void 0,
      destinationIndex: void 0,
      lines: void 0,
      lineIndex: void 0
    };
    return true;
  }
  readFunctionBody() {
    if (this._sectionEntriesLeft === 0) {
      this.skipSection();
      return this.read();
    }
    if (!this.hasVarIntBytes())
      return false;
    var pos = this._pos;
    var size = this.readVarUint32();
    var bodyEnd = this._pos + size;
    if (!this.hasVarIntBytes()) {
      this._pos = pos;
      return false;
    }
    var localCount = this.readVarUint32();
    var locals = [];
    for (var i = 0; i < localCount; i++) {
      if (!this.hasVarIntBytes()) {
        this._pos = pos;
        return false;
      }
      var count = this.readVarUint32();
      if (!this.hasVarIntBytes()) {
        this._pos = pos;
        return false;
      }
      var type = this.readType();
      locals.push({ count, type });
    }
    var bodyStart = this._pos;
    this.state = 28;
    this.result = {
      locals
    };
    this._functionRange = new DataRange(bodyStart, bodyEnd);
    this._sectionEntriesLeft--;
    return true;
  }
  readSectionHeader() {
    if (this._pos >= this._length && this._eof) {
      this._sectionId = -1;
      this._sectionRange = null;
      this.result = null;
      this.state = 2;
      return true;
    }
    if (this._pos < this._length - 4) {
      var magicNumber = this.peekInt32();
      if (magicNumber === WASM_MAGIC_NUMBER) {
        this._sectionId = -1;
        this._sectionRange = null;
        this.result = null;
        this.state = 2;
        return true;
      }
    }
    if (!this.hasVarIntBytes())
      return false;
    var sectionStart = this._pos;
    var id = this.readVarUint7();
    if (!this.hasVarIntBytes()) {
      this._pos = sectionStart;
      return false;
    }
    var payloadLength = this.readVarUint32();
    var name = null;
    var payloadEnd = this._pos + payloadLength;
    if (id == 0) {
      if (!this.hasStringBytes()) {
        this._pos = sectionStart;
        return false;
      }
      name = this.readStringBytes();
    }
    this.result = { id, name };
    this._sectionId = id;
    this._sectionRange = new DataRange(this._pos, payloadEnd);
    this.state = 3;
    return true;
  }
  readSectionRawData() {
    var payloadLength = this._sectionRange.end - this._sectionRange.start;
    if (!this.hasBytes(payloadLength)) {
      return false;
    }
    this.state = 7;
    this.result = this.readBytes(payloadLength);
    return true;
  }
  readSectionBody() {
    if (this._pos >= this._sectionRange.end) {
      this.result = null;
      this.state = 4;
      this._sectionId = -1;
      this._sectionRange = null;
      return true;
    }
    var currentSection = this.result;
    switch (currentSection.id) {
      case 1:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readTypeEntry();
      case 2:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readImportEntry();
      case 7:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readExportEntry();
      case 3:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readFunctionEntry();
      case 4:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readTableEntry();
      case 5:
        if (!this.hasSectionPayload())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readMemoryEntry();
      case 6:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readGlobalEntry();
      case 8:
        if (!this.hasVarIntBytes())
          return false;
        this.state = 22;
        this.result = { index: this.readVarUint32() };
        return true;
      case 10:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        this.state = 29;
        return this.readFunctionBody();
      case 9:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readElementEntry();
      case 11:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readDataEntry();
      case 13:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readEventEntry();
      case 0:
        var customSectionName = bytesToString(currentSection.name);
        if (customSectionName === "name") {
          return this.readNameEntry();
        }
        if (customSectionName.indexOf("reloc.") === 0) {
          return this.readRelocHeader();
        }
        if (customSectionName === "linking") {
          if (!this.hasVarIntBytes())
            return false;
          this._sectionEntriesLeft = this.readVarUint32();
          return this.readLinkingEntry();
        }
        if (customSectionName === "sourceMappingURL") {
          return this.readSourceMappingURL();
        }
        return this.readSectionRawData();
      default:
        this.error = new Error(`Unsupported section: ${this._sectionId}`);
        this.state = -1;
        return true;
    }
  }
  read() {
    switch (this.state) {
      case 0:
        if (!this.hasBytes(8))
          return false;
        var magicNumber = this.readUint32();
        if (magicNumber != WASM_MAGIC_NUMBER) {
          this.error = new Error("Bad magic number");
          this.state = -1;
          return true;
        }
        var version = this.readUint32();
        if (version != WASM_SUPPORTED_VERSION && version != WASM_SUPPORTED_EXPERIMENTAL_VERSION) {
          this.error = new Error(`Bad version number ${version}`);
          this.state = -1;
          return true;
        }
        this.result = { magicNumber, version };
        this.state = 1;
        return true;
      case 2:
        this.result = null;
        this.state = 1;
        if (this.hasMoreBytes()) {
          this.state = 0;
          return this.read();
        }
        return false;
      case -1:
        return true;
      case 1:
      case 4:
        return this.readSectionHeader();
      case 3:
        return this.readSectionBody();
      case 5:
        if (!this.hasSectionPayload()) {
          return false;
        }
        this.state = 4;
        this._pos = this._sectionRange.end;
        this._sectionId = -1;
        this._sectionRange = null;
        this.result = null;
        return true;
      case 32:
        this.state = 31;
        this._pos = this._functionRange.end;
        this._functionRange = null;
        this.result = null;
        return true;
      case 11:
        return this.readTypeEntry();
      case 12:
        return this.readImportEntry();
      case 17:
        return this.readExportEntry();
      case 13:
        return this.readFunctionEntry();
      case 14:
        return this.readTableEntry();
      case 15:
        return this.readMemoryEntry();
      case 23:
        return this.readEventEntry();
      case 16:
      case 40:
        return this.readGlobalEntry();
      case 39:
        return this.readInitExpressionBody();
      case 20:
      case 35:
        return this.readElementEntry();
      case 33:
        if (isActiveElementSegmentType(this._segmentType)) {
          return this.readOffsetExpressionBody();
        } else {
          return this.readElementEntryBody();
        }
      case 34:
        if (!this.hasVarIntBytes())
          return false;
        this._segmentEntriesLeft = this.readVarUint32();
        if (this._segmentEntriesLeft === 0) {
          this.state = 35;
          this.result = null;
          return true;
        }
        return this.readInitExpressionBody();
      case 18:
      case 38:
        return this.readDataEntry();
      case 36:
        if (isActiveDataSegmentType(this._segmentType)) {
          return this.readOffsetExpressionBody();
        } else {
          return this.readDataEntryBody();
        }
      case 37:
        this.state = 38;
        this.result = null;
        return true;
      case 27:
        switch (this._sectionId) {
          case 6:
            this.state = 40;
            return true;
          case 9:
            if (--this._segmentEntriesLeft > 0) {
              return this.readInitExpressionBody();
            }
            this.state = 35;
            this.result = null;
            return true;
        }
        this.error = new Error(`Unexpected section type: ${this._sectionId}`);
        this.state = -1;
        return true;
      case 46:
        if (this._sectionId === 11) {
          return this.readDataEntryBody();
        } else {
          return this.readElementEntryBody();
        }
      case 19:
        return this.readNameEntry();
      case 41:
        if (!this.hasVarIntBytes())
          return false;
        this._sectionEntriesLeft = this.readVarUint32();
        return this.readRelocEntry();
      case 21:
        return this.readLinkingEntry();
      case 43:
        this.state = 4;
        this.result = null;
        return true;
      case 42:
        return this.readRelocEntry();
      case 29:
      case 31:
        return this.readFunctionBody();
      case 28:
        this.state = 30;
        return this.readCodeOperator();
      case 25:
        this.state = 26;
        return this.readCodeOperator();
      case 44:
        this.state = 45;
        return this.readCodeOperator();
      case 30:
      case 26:
      case 45:
        return this.readCodeOperator();
      case 6:
        return this.readSectionRawData();
      case 22:
      case 7:
        this.state = 4;
        this.result = null;
        return true;
      default:
        this.error = new Error(`Unsupported state: ${this.state}`);
        this.state = -1;
        return true;
    }
  }
  skipSection() {
    if (this.state === -1 || this.state === 0 || this.state === 4 || this.state === 1 || this.state === 2)
      return;
    this.state = 5;
  }
  skipFunctionBody() {
    if (this.state !== 28 && this.state !== 30)
      return;
    this.state = 32;
  }
  skipInitExpression() {
    while (this.state === 26)
      this.readCodeOperator();
  }
  fetchSectionRawData() {
    if (this.state !== 3) {
      this.error = new Error(`Unsupported state: ${this.state}`);
      this.state = -1;
      return;
    }
    this.state = 6;
  }
};
var bytesToString;
if (typeof TextDecoder !== "undefined") {
  try {
    bytesToString = (function() {
      var utf8Decoder = new TextDecoder("utf-8");
      utf8Decoder.decode(new Uint8Array([97, 208, 144]));
      return (b) => utf8Decoder.decode(b);
    })();
  } catch (_) {
  }
}
if (!bytesToString) {
  bytesToString = (b) => {
    var str = String.fromCharCode.apply(null, b);
    return decodeURIComponent(escape(str));
  };
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/third_party/wasmparser/package/dist/esm/WasmDis.js
var NAME_SECTION_NAME = "name";
var INVALID_NAME_SYMBOLS_REGEX = /[^0-9A-Za-z!#$%&'*+.:<=>?@^_`|~\/\-]/;
var INVALID_NAME_SYMBOLS_REGEX_GLOBAL = new RegExp(INVALID_NAME_SYMBOLS_REGEX.source, "g");
function formatFloat32(n) {
  if (n === 0)
    return 1 / n < 0 ? "-0.0" : "0.0";
  if (isFinite(n))
    return n.toString();
  if (!isNaN(n))
    return n < 0 ? "-inf" : "inf";
  var view = new DataView(new ArrayBuffer(8));
  view.setFloat32(0, n, true);
  var data = view.getInt32(0, true);
  var payload = data & 8388607;
  const canonicalBits = 4194304;
  if (data > 0 && payload === canonicalBits)
    return "nan";
  else if (payload === canonicalBits)
    return "-nan";
  return (data < 0 ? "-" : "+") + "nan:0x" + payload.toString(16);
}
function formatFloat64(n) {
  if (n === 0)
    return 1 / n < 0 ? "-0.0" : "0.0";
  if (isFinite(n))
    return n.toString();
  if (!isNaN(n))
    return n < 0 ? "-inf" : "inf";
  var view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n, true);
  var data1 = view.getUint32(0, true);
  var data2 = view.getInt32(4, true);
  var payload = data1 + (data2 & 1048575) * 4294967296;
  const canonicalBits = 524288 * 4294967296;
  if (data2 > 0 && payload === canonicalBits)
    return "nan";
  else if (payload === canonicalBits)
    return "-nan";
  return (data2 < 0 ? "-" : "+") + "nan:0x" + payload.toString(16);
}
function formatI32Array(bytes, count) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var result = [];
  for (var i = 0; i < count; i++)
    result.push(`0x${formatHex(dv.getInt32(i << 2, true), 8)}`);
  return result.join(" ");
}
function formatI8Array(bytes, count) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var result = [];
  for (var i = 0; i < count; i++)
    result.push(`${dv.getInt8(i)}`);
  return result.join(" ");
}
function memoryAddressToString(address, code) {
  var defaultAlignFlags;
  switch (code) {
    case 64768:
    case 64769:
    case 64770:
    case 64771:
    case 64772:
    case 64773:
    case 64774:
    case 64775:
    case 64776:
    case 64777:
    case 64778:
    case 64779:
      defaultAlignFlags = 4;
      break;
    case 41:
    case 55:
    case 43:
    case 57:
    case 65026:
    case 65041:
    case 65048:
    case 65055:
    case 65062:
    case 65069:
    case 65076:
    case 65083:
    case 65090:
    case 65097:
    case 64861:
      defaultAlignFlags = 3;
      break;
    case 40:
    case 52:
    case 53:
    case 54:
    case 62:
    case 42:
    case 56:
    case 65024:
    case 65025:
    case 65040:
    case 65046:
    case 65047:
    case 65053:
    case 65054:
    case 65060:
    case 65061:
    case 65067:
    case 65068:
    case 65074:
    case 65075:
    case 65081:
    case 65082:
    case 65088:
    case 65089:
    case 65095:
    case 65096:
    case 65102:
    case 64860:
      defaultAlignFlags = 2;
      break;
    case 46:
    case 47:
    case 50:
    case 51:
    case 59:
    case 61:
    case 65043:
    case 65045:
    case 65050:
    case 65052:
    case 65057:
    case 65059:
    case 65064:
    case 65066:
    case 65071:
    case 65073:
    case 65078:
    case 65080:
    case 65085:
    case 65087:
    case 65092:
    case 65094:
    case 65099:
    case 65101:
      defaultAlignFlags = 1;
      break;
    case 44:
    case 45:
    case 48:
    case 49:
    case 58:
    case 60:
    case 65042:
    case 65044:
    case 65049:
    case 65051:
    case 65056:
    case 65058:
    case 65063:
    case 65065:
    case 65070:
    case 65072:
    case 65077:
    case 65079:
    case 65084:
    case 65086:
    case 65091:
    case 65093:
    case 65098:
    case 65100:
      defaultAlignFlags = 0;
      break;
  }
  if (address.flags == defaultAlignFlags)
    return !address.offset ? null : `offset=${address.offset}`;
  if (!address.offset)
    return `align=${1 << address.flags}`;
  return `offset=${address.offset | 0} align=${1 << address.flags}`;
}
function limitsToString(limits) {
  return limits.initial + (limits.maximum !== void 0 ? " " + limits.maximum : "");
}
var paddingCache = ["0", "00", "000"];
function formatHex(n, width) {
  var s = (n >>> 0).toString(16).toUpperCase();
  if (width === void 0 || s.length >= width)
    return s;
  var paddingIndex = width - s.length - 1;
  while (paddingIndex >= paddingCache.length)
    paddingCache.push(paddingCache[paddingCache.length - 1] + "0");
  return paddingCache[paddingIndex] + s;
}
var IndentIncrement = "  ";
function isValidName(name) {
  return !INVALID_NAME_SYMBOLS_REGEX.test(name);
}
var DefaultNameResolver = class {
  getTypeName(index, isRef) {
    return "$type" + index;
  }
  getTableName(index, isRef) {
    return "$table" + index;
  }
  getMemoryName(index, isRef) {
    return "$memory" + index;
  }
  getGlobalName(index, isRef) {
    return "$global" + index;
  }
  getElementName(index, isRef) {
    return `$elem${index}`;
  }
  getEventName(index, isRef) {
    return `$event${index}`;
  }
  getFunctionName(index, isImport, isRef) {
    return (isImport ? "$import" : "$func") + index;
  }
  getVariableName(funcIndex, index, isRef) {
    return "$var" + index;
  }
  getFieldName(typeIndex, index, isRef) {
    return "$field" + index;
  }
  getLabel(index) {
    return "$label" + index;
  }
};
var EMPTY_STRING_ARRAY = [];
var DevToolsExportMetadata = class {
  constructor(functionExportNames, globalExportNames, memoryExportNames, tableExportNames, eventExportNames) {
    this._functionExportNames = functionExportNames;
    this._globalExportNames = globalExportNames;
    this._memoryExportNames = memoryExportNames;
    this._tableExportNames = tableExportNames;
    this._eventExportNames = eventExportNames;
  }
  getFunctionExportNames(index) {
    var _a2;
    return (_a2 = this._functionExportNames[index]) !== null && _a2 !== void 0 ? _a2 : EMPTY_STRING_ARRAY;
  }
  getGlobalExportNames(index) {
    var _a2;
    return (_a2 = this._globalExportNames[index]) !== null && _a2 !== void 0 ? _a2 : EMPTY_STRING_ARRAY;
  }
  getMemoryExportNames(index) {
    var _a2;
    return (_a2 = this._memoryExportNames[index]) !== null && _a2 !== void 0 ? _a2 : EMPTY_STRING_ARRAY;
  }
  getTableExportNames(index) {
    var _a2;
    return (_a2 = this._tableExportNames[index]) !== null && _a2 !== void 0 ? _a2 : EMPTY_STRING_ARRAY;
  }
  getEventExportNames(index) {
    var _a2;
    return (_a2 = this._eventExportNames[index]) !== null && _a2 !== void 0 ? _a2 : EMPTY_STRING_ARRAY;
  }
};
var NumericNameResolver = class {
  getTypeName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getTableName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getMemoryName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getGlobalName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getElementName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getEventName(index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getFunctionName(index, isImport, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getVariableName(funcIndex, index, isRef) {
    return isRef ? "" + index : `(;${index};)`;
  }
  getFieldName(typeIndex, index, isRef) {
    return isRef ? "" : index + `(;${index};)`;
  }
  getLabel(index) {
    return null;
  }
};
var LabelMode;
(function(LabelMode2) {
  LabelMode2[LabelMode2["Depth"] = 0] = "Depth";
  LabelMode2[LabelMode2["WhenUsed"] = 1] = "WhenUsed";
  LabelMode2[LabelMode2["Always"] = 2] = "Always";
})(LabelMode || (LabelMode = {}));
var WasmDisassembler = class {
  constructor() {
    this._skipTypes = true;
    this._exportMetadata = null;
    this._lines = [];
    this._offsets = [];
    this._buffer = "";
    this._indent = null;
    this._indentLevel = 0;
    this._addOffsets = false;
    this._done = false;
    this._currentPosition = 0;
    this._nameResolver = new DefaultNameResolver();
    this._labelMode = LabelMode.WhenUsed;
    this._functionBodyOffsets = [];
    this._currentFunctionBodyOffset = 0;
    this._currentSectionId = -1;
    this._logFirstInstruction = false;
    this._reset();
  }
  _reset() {
    this._types = [];
    this._funcIndex = 0;
    this._funcTypes = [];
    this._importCount = 0;
    this._globalCount = 0;
    this._memoryCount = 0;
    this._eventCount = 0;
    this._tableCount = 0;
    this._elementCount = 0;
    this._expression = [];
    this._backrefLabels = null;
    this._labelIndex = 0;
  }
  get addOffsets() {
    return this._addOffsets;
  }
  set addOffsets(value) {
    if (this._currentPosition)
      throw new Error("Cannot switch addOffsets during processing.");
    this._addOffsets = value;
  }
  get skipTypes() {
    return this._skipTypes;
  }
  set skipTypes(skipTypes) {
    if (this._currentPosition)
      throw new Error("Cannot switch skipTypes during processing.");
    this._skipTypes = skipTypes;
  }
  get labelMode() {
    return this._labelMode;
  }
  set labelMode(value) {
    if (this._currentPosition)
      throw new Error("Cannot switch labelMode during processing.");
    this._labelMode = value;
  }
  get exportMetadata() {
    return this._exportMetadata;
  }
  set exportMetadata(exportMetadata) {
    if (this._currentPosition)
      throw new Error("Cannot switch exportMetadata during processing.");
    this._exportMetadata = exportMetadata;
  }
  get nameResolver() {
    return this._nameResolver;
  }
  set nameResolver(resolver) {
    if (this._currentPosition)
      throw new Error("Cannot switch nameResolver during processing.");
    this._nameResolver = resolver;
  }
  appendBuffer(s) {
    this._buffer += s;
  }
  newLine() {
    if (this.addOffsets)
      this._offsets.push(this._currentPosition);
    this._lines.push(this._buffer);
    this._buffer = "";
  }
  logStartOfFunctionBodyOffset() {
    if (this.addOffsets) {
      this._currentFunctionBodyOffset = this._currentPosition;
    }
  }
  logEndOfFunctionBodyOffset() {
    if (this.addOffsets) {
      this._functionBodyOffsets.push({
        start: this._currentFunctionBodyOffset,
        end: this._currentPosition
      });
    }
  }
  typeIndexToString(typeIndex) {
    if (typeIndex >= 0)
      return this._nameResolver.getTypeName(typeIndex, true);
    switch (typeIndex) {
      case -16:
        return "func";
      case -17:
        return "extern";
      case -18:
        return "any";
      case -19:
        return "eq";
      case -22:
        return "i31";
      case -25:
        return "data";
    }
  }
  typeToString(type) {
    switch (type.kind) {
      case -1:
        return "i32";
      case -2:
        return "i64";
      case -3:
        return "f32";
      case -4:
        return "f64";
      case -5:
        return "v128";
      case -6:
        return "i8";
      case -7:
        return "i16";
      case -16:
        return "funcref";
      case -17:
        return "externref";
      case -18:
        return "anyref";
      case -19:
        return "eqref";
      case -22:
        return "i31ref";
      case -25:
        return "dataref";
      case -21:
        return `(ref ${this.typeIndexToString(type.index)})`;
      case -20:
        return `(ref null ${this.typeIndexToString(type.index)})`;
      case -24:
        return `(rtt ${this.typeIndexToString(type.index)})`;
      case -23:
        return `(rtt ${type.depth} ${this.typeIndexToString(type.index)})`;
      default:
        throw new Error(`Unexpected type ${JSON.stringify(type)}`);
    }
  }
  maybeMut(type, mutability) {
    return mutability ? `(mut ${type})` : type;
  }
  globalTypeToString(type) {
    const typeStr = this.typeToString(type.contentType);
    return this.maybeMut(typeStr, !!type.mutability);
  }
  printFuncType(typeIndex) {
    var type = this._types[typeIndex];
    if (type.params.length > 0) {
      this.appendBuffer(" (param");
      for (var i = 0; i < type.params.length; i++) {
        this.appendBuffer(" ");
        this.appendBuffer(this.typeToString(type.params[i]));
      }
      this.appendBuffer(")");
    }
    if (type.returns.length > 0) {
      this.appendBuffer(" (result");
      for (var i = 0; i < type.returns.length; i++) {
        this.appendBuffer(" ");
        this.appendBuffer(this.typeToString(type.returns[i]));
      }
      this.appendBuffer(")");
    }
  }
  printStructType(typeIndex) {
    var type = this._types[typeIndex];
    if (type.fields.length === 0)
      return;
    for (var i = 0; i < type.fields.length; i++) {
      const fieldType = this.maybeMut(this.typeToString(type.fields[i]), type.mutabilities[i]);
      const fieldName = this._nameResolver.getFieldName(typeIndex, i, false);
      this.appendBuffer(` (field ${fieldName} ${fieldType})`);
    }
  }
  printArrayType(typeIndex) {
    var type = this._types[typeIndex];
    this.appendBuffer(" (field ");
    this.appendBuffer(this.maybeMut(this.typeToString(type.elementType), type.mutability));
  }
  printBlockType(type) {
    if (type.kind === -64) {
      return;
    }
    if (type.kind === 0) {
      return this.printFuncType(type.index);
    }
    this.appendBuffer(" (result ");
    this.appendBuffer(this.typeToString(type));
    this.appendBuffer(")");
  }
  printString(b) {
    this.appendBuffer('"');
    for (var i = 0; i < b.length; i++) {
      var byte = b[i];
      if (byte < 32 || byte >= 127 || byte == /* " */
      34 || byte == /* \ */
      92) {
        this.appendBuffer("\\" + (byte >> 4).toString(16) + (byte & 15).toString(16));
      } else {
        this.appendBuffer(String.fromCharCode(byte));
      }
    }
    this.appendBuffer('"');
  }
  printExpression(expression) {
    for (const operator of expression) {
      this.appendBuffer("(");
      this.printOperator(operator);
      this.appendBuffer(")");
    }
  }
  // extraDepthOffset is used by "delegate" instructions.
  useLabel(depth, extraDepthOffset = 0) {
    if (!this._backrefLabels) {
      return "" + depth;
    }
    var i = this._backrefLabels.length - depth - 1 - extraDepthOffset;
    if (i < 0) {
      return "" + depth;
    }
    var backrefLabel = this._backrefLabels[i];
    if (!backrefLabel.useLabel) {
      backrefLabel.useLabel = true;
      backrefLabel.label = this._nameResolver.getLabel(this._labelIndex);
      var line = this._lines[backrefLabel.line];
      this._lines[backrefLabel.line] = line.substring(0, backrefLabel.position) + " " + backrefLabel.label + line.substring(backrefLabel.position);
      this._labelIndex++;
    }
    return backrefLabel.label || "" + depth;
  }
  printOperator(operator) {
    var code = operator.code;
    this.appendBuffer(OperatorCodeNames[code]);
    switch (code) {
      case 2:
      case 3:
      case 4:
      case 6:
        if (this._labelMode !== LabelMode.Depth) {
          const backrefLabel2 = {
            line: this._lines.length,
            position: this._buffer.length,
            useLabel: false,
            label: null
          };
          if (this._labelMode === LabelMode.Always) {
            backrefLabel2.useLabel = true;
            backrefLabel2.label = this._nameResolver.getLabel(this._labelIndex++);
            if (backrefLabel2.label) {
              this.appendBuffer(" ");
              this.appendBuffer(backrefLabel2.label);
            }
          }
          this._backrefLabels.push(backrefLabel2);
        }
        this.printBlockType(operator.blockType);
        break;
      case 11:
        if (this._labelMode === LabelMode.Depth) {
          break;
        }
        const backrefLabel = this._backrefLabels.pop();
        if (backrefLabel.label) {
          this.appendBuffer(" ");
          this.appendBuffer(backrefLabel.label);
        }
        break;
      case 12:
      case 13:
      case 212:
      case 214:
      case 64322:
      case 64323:
      case 64352:
      case 64355:
      case 64353:
      case 64356:
      case 64354:
      case 64357:
        this.appendBuffer(" ");
        this.appendBuffer(this.useLabel(operator.brDepth));
        break;
      case 64326:
      case 64327: {
        const label = this.useLabel(operator.brDepth);
        const refType = this._nameResolver.getTypeName(operator.refType, true);
        this.appendBuffer(` ${label} ${refType}`);
        break;
      }
      case 14:
        for (var i = 0; i < operator.brTable.length; i++) {
          this.appendBuffer(" ");
          this.appendBuffer(this.useLabel(operator.brTable[i]));
        }
        break;
      case 9:
        this.appendBuffer(" ");
        this.appendBuffer(this.useLabel(operator.relativeDepth));
        break;
      case 24:
        this.appendBuffer(" ");
        this.appendBuffer(this.useLabel(operator.relativeDepth, 1));
        break;
      case 7:
      case 8:
        var eventName = this._nameResolver.getEventName(operator.eventIndex, true);
        this.appendBuffer(` ${eventName}`);
        break;
      case 208:
        this.appendBuffer(" ");
        this.appendBuffer(this.typeIndexToString(operator.refType));
        break;
      case 16:
      case 18:
      case 210:
        var funcName = this._nameResolver.getFunctionName(operator.funcIndex, operator.funcIndex < this._importCount, true);
        this.appendBuffer(` ${funcName}`);
        break;
      case 17:
      case 19:
        this.printFuncType(operator.typeIndex);
        break;
      case 28: {
        const selectType = this.typeToString(operator.selectType);
        this.appendBuffer(` ${selectType}`);
        break;
      }
      case 32:
      case 33:
      case 34:
        var paramName = this._nameResolver.getVariableName(this._funcIndex, operator.localIndex, true);
        this.appendBuffer(` ${paramName}`);
        break;
      case 35:
      case 36:
        var globalName = this._nameResolver.getGlobalName(operator.globalIndex, true);
        this.appendBuffer(` ${globalName}`);
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 58:
      case 59:
      case 60:
      case 61:
      case 62:
      case 65024:
      case 65025:
      case 65026:
      case 65040:
      case 65041:
      case 65042:
      case 65043:
      case 65044:
      case 65045:
      case 65046:
      case 65047:
      case 65048:
      case 65049:
      case 65050:
      case 65051:
      case 65052:
      case 65053:
      case 65054:
      case 65055:
      case 65056:
      case 65057:
      case 65058:
      case 65059:
      case 65060:
      case 65061:
      case 65062:
      case 65063:
      case 65064:
      case 65065:
      case 65066:
      case 65067:
      case 65068:
      case 65069:
      case 65070:
      case 65071:
      case 65072:
      case 65073:
      case 65074:
      case 65075:
      case 65076:
      case 65077:
      case 65078:
      case 65079:
      case 65080:
      case 65081:
      case 65082:
      case 65083:
      case 65084:
      case 65085:
      case 65086:
      case 65087:
      case 65088:
      case 65089:
      case 65090:
      case 65091:
      case 65092:
      case 65093:
      case 65094:
      case 65095:
      case 65096:
      case 65097:
      case 65098:
      case 65099:
      case 65100:
      case 65101:
      case 65102:
      case 64768:
      case 64769:
      case 64770:
      case 64771:
      case 64772:
      case 64773:
      case 64774:
      case 64775:
      case 64776:
      case 64777:
      case 64778:
      case 64779:
      case 64860:
      case 64861:
        var memoryAddress = memoryAddressToString(operator.memoryAddress, operator.code);
        if (memoryAddress !== null) {
          this.appendBuffer(" ");
          this.appendBuffer(memoryAddress);
        }
        break;
      case 63:
      case 64:
        break;
      case 65:
        this.appendBuffer(` ${operator.literal.toString()}`);
        break;
      case 66:
        this.appendBuffer(` ${operator.literal.toString()}`);
        break;
      case 67:
        this.appendBuffer(` ${formatFloat32(operator.literal)}`);
        break;
      case 68:
        this.appendBuffer(` ${formatFloat64(operator.literal)}`);
        break;
      case 64780:
        this.appendBuffer(` i32x4 ${formatI32Array(operator.literal, 4)}`);
        break;
      case 64781:
        this.appendBuffer(` ${formatI8Array(operator.lines, 16)}`);
        break;
      case 64789:
      case 64790:
      case 64791:
      case 64792:
      case 64793:
      case 64794:
      case 64795:
      case 64796:
      case 64799:
      case 64800:
      case 64797:
      case 64798:
      case 64801:
      case 64802:
        this.appendBuffer(` ${operator.lineIndex}`);
        break;
      case 64520:
      case 64521:
        this.appendBuffer(` ${operator.segmentIndex}`);
        break;
      case 64525:
        const elementName = this._nameResolver.getElementName(operator.segmentIndex, true);
        this.appendBuffer(` ${elementName}`);
        break;
      case 38:
      case 37:
      case 64529: {
        const tableName = this._nameResolver.getTableName(operator.tableIndex, true);
        this.appendBuffer(` ${tableName}`);
        break;
      }
      case 64526: {
        if (operator.tableIndex !== 0 || operator.destinationIndex !== 0) {
          const tableName = this._nameResolver.getTableName(operator.tableIndex, true);
          const destinationName = this._nameResolver.getTableName(operator.destinationIndex, true);
          this.appendBuffer(` ${destinationName} ${tableName}`);
        }
        break;
      }
      case 64524: {
        if (operator.tableIndex !== 0) {
          const tableName = this._nameResolver.getTableName(operator.tableIndex, true);
          this.appendBuffer(` ${tableName}`);
        }
        const elementName2 = this._nameResolver.getElementName(operator.segmentIndex, true);
        this.appendBuffer(` ${elementName2}`);
        break;
      }
      case 64259:
      case 64260:
      case 64261:
      case 64262: {
        const refType = this._nameResolver.getTypeName(operator.refType, true);
        const fieldName = this._nameResolver.getFieldName(operator.refType, operator.fieldIndex, true);
        this.appendBuffer(` ${refType} ${fieldName}`);
        break;
      }
      case 64304:
      case 64305:
      case 64306:
      case 64324:
      case 64325:
      case 64264:
      case 64258:
      case 64263:
      case 64257:
      case 64284:
      case 64274:
      case 64283:
      case 64273:
      case 64275:
      case 64276:
      case 64277:
      case 64278:
      case 64279: {
        const refType = this._nameResolver.getTypeName(operator.refType, true);
        this.appendBuffer(` ${refType}`);
        break;
      }
      case 64280: {
        const dstType = this._nameResolver.getTypeName(operator.refType, true);
        const srcType = this._nameResolver.getTypeName(operator.srcType, true);
        this.appendBuffer(` ${dstType} ${srcType}`);
        break;
      }
      case 64281:
      case 64282: {
        const refType = this._nameResolver.getTypeName(operator.refType, true);
        const length = operator.brDepth;
        this.appendBuffer(` ${refType} ${length}`);
        break;
      }
    }
  }
  printImportSource(info) {
    this.printString(info.module);
    this.appendBuffer(" ");
    this.printString(info.field);
  }
  increaseIndent() {
    this._indent += IndentIncrement;
    this._indentLevel++;
  }
  decreaseIndent() {
    this._indent = this._indent.slice(0, -IndentIncrement.length);
    this._indentLevel--;
  }
  disassemble(reader) {
    const done = this.disassembleChunk(reader);
    if (!done)
      return null;
    let lines = this._lines;
    if (this._addOffsets) {
      lines = lines.map((line, index) => {
        var position = formatHex(this._offsets[index], 4);
        return line + " ;; @" + position;
      });
    }
    lines.push("");
    const result = lines.join("\n");
    this._lines.length = 0;
    this._offsets.length = 0;
    this._functionBodyOffsets.length = 0;
    return result;
  }
  getResult() {
    let linesReady = this._lines.length;
    if (this._backrefLabels && this._labelMode === LabelMode.WhenUsed) {
      this._backrefLabels.some((backrefLabel) => {
        if (backrefLabel.useLabel)
          return false;
        linesReady = backrefLabel.line;
        return true;
      });
    }
    if (linesReady === 0) {
      return {
        lines: [],
        offsets: this._addOffsets ? [] : void 0,
        done: this._done,
        functionBodyOffsets: this._addOffsets ? [] : void 0
      };
    }
    if (linesReady === this._lines.length) {
      const result2 = {
        lines: this._lines,
        offsets: this._addOffsets ? this._offsets : void 0,
        done: this._done,
        functionBodyOffsets: this._addOffsets ? this._functionBodyOffsets : void 0
      };
      this._lines = [];
      if (this._addOffsets) {
        this._offsets = [];
        this._functionBodyOffsets = [];
      }
      return result2;
    }
    const result = {
      lines: this._lines.splice(0, linesReady),
      offsets: this._addOffsets ? this._offsets.splice(0, linesReady) : void 0,
      done: false,
      functionBodyOffsets: this._addOffsets ? this._functionBodyOffsets : void 0
    };
    if (this._backrefLabels) {
      this._backrefLabels.forEach((backrefLabel) => {
        backrefLabel.line -= linesReady;
      });
    }
    return result;
  }
  disassembleChunk(reader, offsetInModule = 0) {
    if (this._done)
      throw new Error("Invalid state: disassembly process was already finished.");
    while (true) {
      this._currentPosition = reader.position + offsetInModule;
      if (!reader.read())
        return false;
      switch (reader.state) {
        case 2:
          this.appendBuffer(")");
          this.newLine();
          this._reset();
          if (!reader.hasMoreBytes()) {
            this._done = true;
            return true;
          }
          break;
        case -1:
          throw reader.error;
        case 1:
          this.appendBuffer("(module");
          this.newLine();
          break;
        case 4:
          this._currentSectionId = -1;
          break;
        case 3:
          var sectionInfo = reader.result;
          switch (sectionInfo.id) {
            case 1:
            case 2:
            case 7:
            case 6:
            case 3:
            case 8:
            case 10:
            case 5:
            case 11:
            case 4:
            case 9:
            case 13:
              this._currentSectionId = sectionInfo.id;
              break;
            // reading known section;
            default:
              reader.skipSection();
              break;
          }
          break;
        case 15:
          var memoryInfo = reader.result;
          var memoryIndex = this._memoryCount++;
          var memoryName = this._nameResolver.getMemoryName(memoryIndex, false);
          this.appendBuffer(`  (memory ${memoryName}`);
          if (this._exportMetadata !== null) {
            for (const exportName of this._exportMetadata.getMemoryExportNames(memoryIndex)) {
              this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
            }
          }
          this.appendBuffer(` ${limitsToString(memoryInfo.limits)}`);
          if (memoryInfo.shared) {
            this.appendBuffer(` shared`);
          }
          this.appendBuffer(")");
          this.newLine();
          break;
        case 23:
          var eventInfo = reader.result;
          var eventIndex = this._eventCount++;
          var eventName = this._nameResolver.getEventName(eventIndex, false);
          this.appendBuffer(`  (event ${eventName}`);
          if (this._exportMetadata !== null) {
            for (const exportName of this._exportMetadata.getEventExportNames(eventIndex)) {
              this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
            }
          }
          this.printFuncType(eventInfo.typeIndex);
          this.appendBuffer(")");
          this.newLine();
          break;
        case 14:
          var tableInfo = reader.result;
          var tableIndex = this._tableCount++;
          var tableName = this._nameResolver.getTableName(tableIndex, false);
          this.appendBuffer(`  (table ${tableName}`);
          if (this._exportMetadata !== null) {
            for (const exportName of this._exportMetadata.getTableExportNames(tableIndex)) {
              this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
            }
          }
          this.appendBuffer(` ${limitsToString(tableInfo.limits)} ${this.typeToString(tableInfo.elementType)})`);
          this.newLine();
          break;
        case 17:
          if (this._exportMetadata === null) {
            var exportInfo = reader.result;
            this.appendBuffer("  (export ");
            this.printString(exportInfo.field);
            this.appendBuffer(" ");
            switch (exportInfo.kind) {
              case 0:
                var funcName = this._nameResolver.getFunctionName(exportInfo.index, exportInfo.index < this._importCount, true);
                this.appendBuffer(`(func ${funcName})`);
                break;
              case 1:
                var tableName = this._nameResolver.getTableName(exportInfo.index, true);
                this.appendBuffer(`(table ${tableName})`);
                break;
              case 2:
                var memoryName = this._nameResolver.getMemoryName(exportInfo.index, true);
                this.appendBuffer(`(memory ${memoryName})`);
                break;
              case 3:
                var globalName = this._nameResolver.getGlobalName(exportInfo.index, true);
                this.appendBuffer(`(global ${globalName})`);
                break;
              case 4:
                var eventName = this._nameResolver.getEventName(exportInfo.index, true);
                this.appendBuffer(`(event ${eventName})`);
                break;
              default:
                throw new Error(`Unsupported export ${exportInfo.kind}`);
            }
            this.appendBuffer(")");
            this.newLine();
          }
          break;
        case 12:
          var importInfo = reader.result;
          switch (importInfo.kind) {
            case 0:
              this._importCount++;
              var funcIndex = this._funcIndex++;
              var funcName = this._nameResolver.getFunctionName(funcIndex, true, false);
              this.appendBuffer(`  (func ${funcName}`);
              if (this._exportMetadata !== null) {
                for (const exportName of this._exportMetadata.getFunctionExportNames(funcIndex)) {
                  this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
                }
              }
              this.appendBuffer(` (import `);
              this.printImportSource(importInfo);
              this.appendBuffer(")");
              this.printFuncType(importInfo.funcTypeIndex);
              this.appendBuffer(")");
              break;
            case 3:
              var globalImportInfo = importInfo.type;
              var globalIndex = this._globalCount++;
              var globalName = this._nameResolver.getGlobalName(globalIndex, false);
              this.appendBuffer(`  (global ${globalName}`);
              if (this._exportMetadata !== null) {
                for (const exportName of this._exportMetadata.getGlobalExportNames(globalIndex)) {
                  this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
                }
              }
              this.appendBuffer(` (import `);
              this.printImportSource(importInfo);
              this.appendBuffer(`) ${this.globalTypeToString(globalImportInfo)})`);
              break;
            case 2:
              var memoryImportInfo = importInfo.type;
              var memoryIndex = this._memoryCount++;
              var memoryName = this._nameResolver.getMemoryName(memoryIndex, false);
              this.appendBuffer(`  (memory ${memoryName}`);
              if (this._exportMetadata !== null) {
                for (const exportName of this._exportMetadata.getMemoryExportNames(memoryIndex)) {
                  this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
                }
              }
              this.appendBuffer(` (import `);
              this.printImportSource(importInfo);
              this.appendBuffer(`) ${limitsToString(memoryImportInfo.limits)}`);
              if (memoryImportInfo.shared) {
                this.appendBuffer(` shared`);
              }
              this.appendBuffer(")");
              break;
            case 1:
              var tableImportInfo = importInfo.type;
              var tableIndex = this._tableCount++;
              var tableName = this._nameResolver.getTableName(tableIndex, false);
              this.appendBuffer(`  (table ${tableName}`);
              if (this._exportMetadata !== null) {
                for (const exportName of this._exportMetadata.getTableExportNames(tableIndex)) {
                  this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
                }
              }
              this.appendBuffer(` (import `);
              this.printImportSource(importInfo);
              this.appendBuffer(`) ${limitsToString(tableImportInfo.limits)} ${this.typeToString(tableImportInfo.elementType)})`);
              break;
            case 4:
              var eventImportInfo = importInfo.type;
              var eventIndex = this._eventCount++;
              var eventName = this._nameResolver.getEventName(eventIndex, false);
              this.appendBuffer(`  (event ${eventName}`);
              if (this._exportMetadata !== null) {
                for (const exportName of this._exportMetadata.getEventExportNames(eventIndex)) {
                  this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
                }
              }
              this.appendBuffer(` (import `);
              this.printImportSource(importInfo);
              this.appendBuffer(")");
              this.printFuncType(eventImportInfo.typeIndex);
              this.appendBuffer(")");
              break;
            default:
              throw new Error(`NYI other import types: ${importInfo.kind}`);
          }
          this.newLine();
          break;
        case 33:
          var elementSegment = reader.result;
          var elementIndex = this._elementCount++;
          var elementName = this._nameResolver.getElementName(elementIndex, false);
          this.appendBuffer(`  (elem ${elementName}`);
          switch (elementSegment.mode) {
            case 0:
              if (elementSegment.tableIndex !== 0) {
                const tableName2 = this._nameResolver.getTableName(elementSegment.tableIndex, false);
                this.appendBuffer(` (table ${tableName2})`);
              }
              break;
            case 1:
              break;
            case 2:
              this.appendBuffer(" declare");
              break;
          }
          break;
        case 35:
          this.appendBuffer(")");
          this.newLine();
          break;
        case 34:
          const elementSegmentBody = reader.result;
          this.appendBuffer(` ${this.typeToString(elementSegmentBody.elementType)}`);
          break;
        case 39:
          var globalInfo = reader.result;
          var globalIndex = this._globalCount++;
          var globalName = this._nameResolver.getGlobalName(globalIndex, false);
          this.appendBuffer(`  (global ${globalName}`);
          if (this._exportMetadata !== null) {
            for (const exportName of this._exportMetadata.getGlobalExportNames(globalIndex)) {
              this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
            }
          }
          this.appendBuffer(` ${this.globalTypeToString(globalInfo.type)}`);
          break;
        case 40:
          this.appendBuffer(")");
          this.newLine();
          break;
        case 11:
          var typeEntry = reader.result;
          var typeIndex = this._types.length;
          this._types.push(typeEntry);
          if (!this._skipTypes) {
            var typeName = this._nameResolver.getTypeName(typeIndex, false);
            var superTypeName = void 0;
            if (typeEntry.supertype !== void 0) {
              superTypeName = this.typeIndexToString(typeEntry.supertype);
            }
            if (typeEntry.form === -32) {
              this.appendBuffer(`  (type ${typeName} (func`);
              this.printFuncType(typeIndex);
              this.appendBuffer("))");
            } else if (typeEntry.form === -35) {
              this.appendBuffer(`  (type ${typeName} (func_subtype`);
              this.printFuncType(typeIndex);
              this.appendBuffer(` (supertype ${superTypeName})))`);
            } else if (typeEntry.form === -33) {
              this.appendBuffer(`  (type ${typeName} (struct`);
              this.printStructType(typeIndex);
              this.appendBuffer("))");
            } else if (typeEntry.form === -36) {
              this.appendBuffer(`  (type ${typeName} (struct_subtype`);
              this.printStructType(typeIndex);
              this.appendBuffer(` (supertype ${superTypeName})))`);
            } else if (typeEntry.form === -34) {
              this.appendBuffer(`  (type ${typeName} (array`);
              this.printArrayType(typeIndex);
              this.appendBuffer("))");
            } else if (typeEntry.form === -37) {
              this.appendBuffer(`  (type ${typeName} (array_subtype`);
              this.printArrayType(typeIndex);
              this.appendBuffer(`) (supertype ${superTypeName})))`);
            } else {
              throw new Error(`Unknown type form: ${typeEntry.form}`);
            }
            this.newLine();
          }
          break;
        case 22:
          var startEntry = reader.result;
          var funcName = this._nameResolver.getFunctionName(startEntry.index, startEntry.index < this._importCount, true);
          this.appendBuffer(`  (start ${funcName})`);
          this.newLine();
          break;
        case 36:
          this.appendBuffer("  (data");
          break;
        case 37:
          var body = reader.result;
          this.appendBuffer(" ");
          this.printString(body.data);
          break;
        case 38:
          this.appendBuffer(")");
          this.newLine();
          break;
        case 25:
        case 44:
          this._expression = [];
          break;
        case 26:
        case 45:
          var operator = reader.result;
          if (operator.code !== 11) {
            this._expression.push(operator);
          }
          break;
        case 46:
          if (this._expression.length > 1) {
            this.appendBuffer(" (offset ");
            this.printExpression(this._expression);
            this.appendBuffer(")");
          } else {
            this.appendBuffer(" ");
            this.printExpression(this._expression);
          }
          this._expression = [];
          break;
        case 27:
          if (this._expression.length > 1 && this._currentSectionId === 9) {
            this.appendBuffer(" (item ");
            this.printExpression(this._expression);
            this.appendBuffer(")");
          } else {
            this.appendBuffer(" ");
            this.printExpression(this._expression);
          }
          this._expression = [];
          break;
        case 13:
          this._funcTypes.push(reader.result.typeIndex);
          break;
        case 28:
          var func = reader.result;
          var type = this._types[this._funcTypes[this._funcIndex - this._importCount]];
          this.appendBuffer("  (func ");
          this.appendBuffer(this._nameResolver.getFunctionName(this._funcIndex, false, false));
          if (this._exportMetadata !== null) {
            for (const exportName of this._exportMetadata.getFunctionExportNames(this._funcIndex)) {
              this.appendBuffer(` (export ${JSON.stringify(exportName)})`);
            }
          }
          for (var i = 0; i < type.params.length; i++) {
            var paramName = this._nameResolver.getVariableName(this._funcIndex, i, false);
            this.appendBuffer(` (param ${paramName} ${this.typeToString(type.params[i])})`);
          }
          for (var i = 0; i < type.returns.length; i++) {
            this.appendBuffer(` (result ${this.typeToString(type.returns[i])})`);
          }
          this.newLine();
          var localIndex = type.params.length;
          if (func.locals.length > 0) {
            this.appendBuffer("   ");
            for (var l of func.locals) {
              for (var i = 0; i < l.count; i++) {
                var paramName = this._nameResolver.getVariableName(this._funcIndex, localIndex++, false);
                this.appendBuffer(` (local ${paramName} ${this.typeToString(l.type)})`);
              }
            }
            this.newLine();
          }
          this._indent = "    ";
          this._indentLevel = 0;
          this._labelIndex = 0;
          this._backrefLabels = this._labelMode === LabelMode.Depth ? null : [];
          this._logFirstInstruction = true;
          break;
        case 30:
          if (this._logFirstInstruction) {
            this.logStartOfFunctionBodyOffset();
            this._logFirstInstruction = false;
          }
          var operator = reader.result;
          if (operator.code == 11 && this._indentLevel == 0) {
            this.appendBuffer(`  )`);
            this.newLine();
            break;
          }
          switch (operator.code) {
            case 11:
            case 5:
            case 7:
            case 25:
            case 10:
            case 24:
              this.decreaseIndent();
              break;
          }
          this.appendBuffer(this._indent);
          this.printOperator(operator);
          this.newLine();
          switch (operator.code) {
            case 4:
            case 2:
            case 3:
            case 5:
            case 6:
            case 7:
            case 25:
            case 10:
              this.increaseIndent();
              break;
          }
          break;
        case 31:
          this._funcIndex++;
          this._backrefLabels = null;
          this.logEndOfFunctionBodyOffset();
          break;
        default:
          throw new Error(`Expectected state: ${reader.state}`);
      }
    }
  }
};
var UNKNOWN_FUNCTION_PREFIX = "unknown";
var NameSectionNameResolver = class extends DefaultNameResolver {
  constructor(functionNames, localNames, eventNames, typeNames, tableNames, memoryNames, globalNames, fieldNames) {
    super();
    this._functionNames = functionNames;
    this._localNames = localNames;
    this._eventNames = eventNames;
    this._typeNames = typeNames;
    this._tableNames = tableNames;
    this._memoryNames = memoryNames;
    this._globalNames = globalNames;
    this._fieldNames = fieldNames;
  }
  getTypeName(index, isRef) {
    const name = this._typeNames[index];
    if (!name)
      return super.getTypeName(index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getTableName(index, isRef) {
    const name = this._tableNames[index];
    if (!name)
      return super.getTableName(index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getMemoryName(index, isRef) {
    const name = this._memoryNames[index];
    if (!name)
      return super.getMemoryName(index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getGlobalName(index, isRef) {
    const name = this._globalNames[index];
    if (!name)
      return super.getGlobalName(index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getEventName(index, isRef) {
    const name = this._eventNames[index];
    if (!name)
      return super.getEventName(index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getFunctionName(index, isImport, isRef) {
    const name = this._functionNames[index];
    if (!name)
      return `$${UNKNOWN_FUNCTION_PREFIX}${index}`;
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getVariableName(funcIndex, index, isRef) {
    const name = this._localNames[funcIndex] && this._localNames[funcIndex][index];
    if (!name)
      return super.getVariableName(funcIndex, index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
  getFieldName(typeIndex, index, isRef) {
    const name = this._fieldNames[typeIndex] && this._fieldNames[typeIndex][index];
    if (!name)
      return super.getFieldName(typeIndex, index, isRef);
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
};
var NameSectionReader = class {
  constructor() {
    this._done = false;
    this._functionsCount = 0;
    this._functionImportsCount = 0;
    this._functionNames = null;
    this._functionLocalNames = null;
    this._eventNames = null;
    this._typeNames = null;
    this._tableNames = null;
    this._memoryNames = null;
    this._globalNames = null;
    this._fieldNames = null;
    this._hasNames = false;
  }
  read(reader) {
    if (this._done)
      throw new Error("Invalid state: disassembly process was already finished.");
    while (true) {
      if (!reader.read())
        return false;
      switch (reader.state) {
        case 2:
          if (!reader.hasMoreBytes()) {
            this._done = true;
            return true;
          }
          break;
        case -1:
          throw reader.error;
        case 1:
          this._functionsCount = 0;
          this._functionImportsCount = 0;
          this._functionNames = [];
          this._functionLocalNames = [];
          this._eventNames = [];
          this._typeNames = [];
          this._tableNames = [];
          this._memoryNames = [];
          this._globalNames = [];
          this._fieldNames = [];
          this._hasNames = false;
          break;
        case 4:
          break;
        case 3:
          var sectionInfo = reader.result;
          if (sectionInfo.id === 0 && bytesToString(sectionInfo.name) === NAME_SECTION_NAME) {
            break;
          }
          if (sectionInfo.id === 3 || sectionInfo.id === 2) {
            break;
          }
          reader.skipSection();
          break;
        case 12:
          var importInfo = reader.result;
          if (importInfo.kind === 0)
            this._functionImportsCount++;
          break;
        case 13:
          this._functionsCount++;
          break;
        case 19:
          const nameInfo = reader.result;
          if (nameInfo.type === 1) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._functionNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 2) {
            const { funcs } = nameInfo;
            funcs.forEach(({ index, locals }) => {
              const localNames = this._functionLocalNames[index] = [];
              locals.forEach(({ index: index2, name }) => {
                localNames[index2] = bytesToString(name);
              });
            });
            this._hasNames = true;
          } else if (nameInfo.type === 3) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._eventNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 4) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._typeNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 5) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._tableNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 6) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._memoryNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 7) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._globalNames[index] = bytesToString(name);
            });
            this._hasNames = true;
          } else if (nameInfo.type === 10) {
            const { types } = nameInfo;
            types.forEach(({ index, fields }) => {
              const fieldNames = this._fieldNames[index] = [];
              fields.forEach(({ index: index2, name }) => {
                fieldNames[index2] = bytesToString(name);
              });
            });
          }
          break;
        default:
          throw new Error(`Expectected state: ${reader.state}`);
      }
    }
  }
  hasValidNames() {
    return this._hasNames;
  }
  getNameResolver() {
    if (!this.hasValidNames())
      throw new Error("Has no valid name section");
    const functionNamesLength = this._functionImportsCount + this._functionsCount;
    const functionNames = this._functionNames.slice(0, functionNamesLength);
    const usedNameAt = /* @__PURE__ */ Object.create(null);
    for (let i = 0; i < functionNames.length; i++) {
      const name = functionNames[i];
      if (!name)
        continue;
      const goodName = !(name in usedNameAt) && isValidName(name) && name.indexOf(UNKNOWN_FUNCTION_PREFIX) !== 0;
      if (!goodName) {
        if (usedNameAt[name] >= 0) {
          functionNames[usedNameAt[name]] = null;
          usedNameAt[name] = -1;
        }
        functionNames[i] = null;
        continue;
      }
      usedNameAt[name] = i;
    }
    return new NameSectionNameResolver(functionNames, this._functionLocalNames, this._eventNames, this._typeNames, this._tableNames, this._memoryNames, this._globalNames, this._fieldNames);
  }
};
var DevToolsNameResolver = class extends NameSectionNameResolver {
  constructor(functionNames, localNames, eventNames, typeNames, tableNames, memoryNames, globalNames, fieldNames) {
    super(functionNames, localNames, eventNames, typeNames, tableNames, memoryNames, globalNames, fieldNames);
  }
  getFunctionName(index, isImport, isRef) {
    const name = this._functionNames[index];
    if (!name)
      return isImport ? `$import${index}` : `$func${index}`;
    return isRef ? `$${name}` : `$${name} (;${index};)`;
  }
};
var DevToolsNameGenerator = class {
  constructor() {
    this._done = false;
    this._functionImportsCount = 0;
    this._memoryImportsCount = 0;
    this._tableImportsCount = 0;
    this._globalImportsCount = 0;
    this._eventImportsCount = 0;
    this._functionNames = null;
    this._functionLocalNames = null;
    this._eventNames = null;
    this._memoryNames = null;
    this._typeNames = null;
    this._tableNames = null;
    this._globalNames = null;
    this._fieldNames = null;
    this._functionExportNames = null;
    this._globalExportNames = null;
    this._memoryExportNames = null;
    this._tableExportNames = null;
    this._eventExportNames = null;
  }
  _addExportName(exportNames, index, name) {
    const names = exportNames[index];
    if (names) {
      names.push(name);
    } else {
      exportNames[index] = [name];
    }
  }
  _setName(names, index, name, isNameSectionName) {
    if (!name)
      return;
    if (isNameSectionName) {
      if (!isValidName(name))
        return;
      names[index] = name;
    } else if (!names[index]) {
      names[index] = name.replace(INVALID_NAME_SYMBOLS_REGEX_GLOBAL, "_");
    }
  }
  read(reader) {
    if (this._done)
      throw new Error("Invalid state: disassembly process was already finished.");
    while (true) {
      if (!reader.read())
        return false;
      switch (reader.state) {
        case 2:
          if (!reader.hasMoreBytes()) {
            this._done = true;
            return true;
          }
          break;
        case -1:
          throw reader.error;
        case 1:
          this._functionImportsCount = 0;
          this._memoryImportsCount = 0;
          this._tableImportsCount = 0;
          this._globalImportsCount = 0;
          this._eventImportsCount = 0;
          this._functionNames = [];
          this._functionLocalNames = [];
          this._eventNames = [];
          this._memoryNames = [];
          this._typeNames = [];
          this._tableNames = [];
          this._globalNames = [];
          this._fieldNames = [];
          this._functionExportNames = [];
          this._globalExportNames = [];
          this._memoryExportNames = [];
          this._tableExportNames = [];
          this._eventExportNames = [];
          break;
        case 4:
          break;
        case 3:
          var sectionInfo = reader.result;
          if (sectionInfo.id === 0 && bytesToString(sectionInfo.name) === NAME_SECTION_NAME) {
            break;
          }
          switch (sectionInfo.id) {
            case 2:
            case 7:
              break;
            // reading known section;
            default:
              reader.skipSection();
              break;
          }
          break;
        case 12:
          var importInfo = reader.result;
          const importName = `${bytesToString(importInfo.module)}.${bytesToString(importInfo.field)}`;
          switch (importInfo.kind) {
            case 0:
              this._setName(this._functionNames, this._functionImportsCount++, importName, false);
              break;
            case 1:
              this._setName(this._tableNames, this._tableImportsCount++, importName, false);
              break;
            case 2:
              this._setName(this._memoryNames, this._memoryImportsCount++, importName, false);
              break;
            case 3:
              this._setName(this._globalNames, this._globalImportsCount++, importName, false);
              break;
            case 4:
              this._setName(this._eventNames, this._eventImportsCount++, importName, false);
            default:
              throw new Error(`Unsupported export ${importInfo.kind}`);
          }
          break;
        case 19:
          const nameInfo = reader.result;
          if (nameInfo.type === 1) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._functionNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 2) {
            const { funcs } = nameInfo;
            funcs.forEach(({ index, locals }) => {
              const localNames = this._functionLocalNames[index] = [];
              locals.forEach(({ index: index2, name }) => {
                localNames[index2] = bytesToString(name);
              });
            });
          } else if (nameInfo.type === 3) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._eventNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 4) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._typeNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 5) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._tableNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 6) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._memoryNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 7) {
            const { names } = nameInfo;
            names.forEach(({ index, name }) => {
              this._setName(this._globalNames, index, bytesToString(name), true);
            });
          } else if (nameInfo.type === 10) {
            const { types } = nameInfo;
            types.forEach(({ index, fields }) => {
              const fieldNames = this._fieldNames[index] = [];
              fields.forEach(({ index: index2, name }) => {
                fieldNames[index2] = bytesToString(name);
              });
            });
          }
          break;
        case 17:
          var exportInfo = reader.result;
          const exportName = bytesToString(exportInfo.field);
          switch (exportInfo.kind) {
            case 0:
              this._addExportName(this._functionExportNames, exportInfo.index, exportName);
              this._setName(this._functionNames, exportInfo.index, exportName, false);
              break;
            case 3:
              this._addExportName(this._globalExportNames, exportInfo.index, exportName);
              this._setName(this._globalNames, exportInfo.index, exportName, false);
              break;
            case 2:
              this._addExportName(this._memoryExportNames, exportInfo.index, exportName);
              this._setName(this._memoryNames, exportInfo.index, exportName, false);
              break;
            case 1:
              this._addExportName(this._tableExportNames, exportInfo.index, exportName);
              this._setName(this._tableNames, exportInfo.index, exportName, false);
              break;
            case 4:
              this._addExportName(this._eventExportNames, exportInfo.index, exportName);
              this._setName(this._eventNames, exportInfo.index, exportName, false);
              break;
            default:
              throw new Error(`Unsupported export ${exportInfo.kind}`);
          }
          break;
        default:
          throw new Error(`Expectected state: ${reader.state}`);
      }
    }
  }
  getExportMetadata() {
    return new DevToolsExportMetadata(this._functionExportNames, this._globalExportNames, this._memoryExportNames, this._tableExportNames, this._eventExportNames);
  }
  getNameResolver() {
    return new DevToolsNameResolver(this._functionNames, this._functionLocalNames, this._eventNames, this._typeNames, this._tableNames, this._memoryNames, this._globalNames, this._fieldNames);
  }
};

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/entrypoints/wasmparser_worker/WasmParserWorker.ts
function dissambleWASM(params, postMessage) {
  try {
    const dataBuffer = Base64_exports.decode(params.content);
    let parser = new WasmParser_exports.BinaryReader();
    parser.setData(dataBuffer.buffer, 0, dataBuffer.byteLength);
    const nameGenerator = new WasmDis_exports.DevToolsNameGenerator();
    nameGenerator.read(parser);
    const data = new Uint8Array(dataBuffer);
    parser = new WasmParser_exports.BinaryReader();
    const dis = new WasmDis_exports.WasmDisassembler();
    dis.addOffsets = true;
    dis.exportMetadata = nameGenerator.getExportMetadata();
    dis.nameResolver = nameGenerator.getNameResolver();
    const lines = [];
    const offsets = [];
    const functionBodyOffsets = [];
    let chunkSize = 128 * 1024;
    let buffer = new Uint8Array(chunkSize);
    let pendingSize = 0;
    let offsetInModule = 0;
    for (let i = 0; i < data.length; ) {
      if (chunkSize > data.length - i) {
        chunkSize = data.length - i;
      }
      const bufferSize = pendingSize + chunkSize;
      if (buffer.byteLength < bufferSize) {
        const newBuffer = new Uint8Array(bufferSize);
        newBuffer.set(buffer);
        buffer = newBuffer;
      }
      while (pendingSize < bufferSize) {
        buffer[pendingSize++] = data[i++];
      }
      parser.setData(buffer.buffer, 0, bufferSize, i === data.length);
      const finished = dis.disassembleChunk(parser, offsetInModule);
      const result = dis.getResult();
      for (const line of result.lines) {
        lines.push(line);
      }
      for (const offset of result.offsets) {
        offsets.push(offset);
      }
      for (const functionBodyOffset of result.functionBodyOffsets) {
        functionBodyOffsets.push(functionBodyOffset);
      }
      if (finished) {
        break;
      }
      if (parser.position === 0) {
        pendingSize = bufferSize;
        continue;
      }
      const pending = parser.data.subarray(parser.position, parser.length);
      pendingSize = pending.length;
      buffer.set(pending);
      offsetInModule += parser.position;
      const percentage = Math.floor(offsetInModule / data.length * 100);
      postMessage({ event: "progress", params: { percentage } });
    }
    postMessage({ event: "progress", params: { percentage: 100 } });
    postMessage({ method: "disassemble", result: { lines, offsets, functionBodyOffsets } });
  } catch (error) {
    postMessage({ method: "disassemble", error });
  }
}

// devtools-frontend-61277feec01840bfa7cffb21d90bed500f973c70/front_end/entrypoints/wasmparser_worker/wasmparser_worker-entrypoint.ts
HostRuntime_exports2.HOST_RUNTIME.workerScope.onmessage = (event) => {
  const method = event.data.method;
  if (method !== "disassemble") {
    return;
  }
  HostRuntime_exports2.HOST_RUNTIME.workerScope.postMessage(WasmParserWorker_exports.dissambleWASM(event.data.params, (message) => {
    HostRuntime_exports2.HOST_RUNTIME.workerScope.postMessage(message);
  }));
};
HostRuntime_exports2.HOST_RUNTIME.workerScope.postMessage("workerReady");
/*! For license information please see wasmparser-worker.js.LEGAL.txt */
