import Foundation
import JavaScriptCore
import Security

// JSContext test runner for pdf-worker
// Usage: jsctx <script1.js> [script2.js ...]
// Loads scripts in order into a single JSContext with native bridges.
// The last script should call __nativeReportResult(json) with test results.

func readFile(_ path: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: path), encoding: .utf8)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: jsctx <script1.js> [script2.js ...]\n", stderr)
    exit(2)
}

let scriptPaths = Array(args[1...])

let ctx = JSContext()!

var resultReceived = false
var testsPassed = false

ctx.exceptionHandler = { _, exception in
    let msg = exception?.toString() ?? "<unknown JS exception>"
    fputs("JS exception: \(msg)\n", stderr)
    testsPassed = false
}

// --- Native bridges ---

// __nativeLog(argsArray)
let nativeLog: @convention(block) (JSValue) -> Void = { jsArgs in
    if let arr = jsArgs.toArray() {
        let line = arr.map { String(describing: $0) }.joined(separator: " ")
        print(line)
    } else {
        print(jsArgs.toString() ?? "")
    }
}
ctx.setObject(nativeLog, forKeyedSubscript: "__nativeLog" as NSString)

// __nativeUUID()
let nativeUUID: @convention(block) () -> String = {
    UUID().uuidString.lowercased()
}
ctx.setObject(nativeUUID, forKeyedSubscript: "__nativeUUID" as NSString)

// __nativeRandom(u8)
let nativeRandom: @convention(block) (JSValue) -> JSValue = { u8 in
    let length = Int(u8.forProperty("length")?.toInt32() ?? 0)
    if length > 0 {
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        for i in 0..<bytes.count {
            u8.setValue(Int(bytes[i]), at: i)
        }
    }
    return u8
}
ctx.setObject(nativeRandom, forKeyedSubscript: "__nativeRandom" as NSString)

// __nativeAtob(str) - base64 decode
let nativeAtob: @convention(block) (String) -> String = { input in
    let data = Data(base64Encoded: input) ?? Data()
    return String(data: data, encoding: .utf8) ?? ""
}
ctx.setObject(nativeAtob, forKeyedSubscript: "__nativeAtob" as NSString)

// __nativeBtoa(str) - base64 encode
let nativeBtoa: @convention(block) (String) -> String = { input in
    Data(input.utf8).base64EncodedString()
}
ctx.setObject(nativeBtoa, forKeyedSubscript: "__nativeBtoa" as NSString)

// __nativeTextDecode(u8, encoding)
let nativeTextDecode: @convention(block) (JSValue, String) -> String = { u8, encoding in
    if u8.isUndefined || u8.isNull { return "" }
    let lengthVal = u8.forProperty("length")
    if lengthVal == nil || lengthVal!.isUndefined || lengthVal!.isNull { return "" }
    let length = Int(lengthVal!.toInt32())
    if length <= 0 { return "" }
    var bytes = [UInt8](repeating: 0, count: length)
    for i in 0..<length {
        bytes[i] = UInt8(clamping: Int(u8.atIndex(i)?.toInt32() ?? 0))
    }
    let data = Data(bytes)
    let enc = encoding.lowercased()
    if enc == "utf-16le" { return String(data: data, encoding: .utf16LittleEndian) ?? "" }
    if enc == "utf-16be" { return String(data: data, encoding: .utf16BigEndian) ?? "" }
    return String(data: data, encoding: .utf8) ?? ""
}
ctx.setObject(nativeTextDecode, forKeyedSubscript: "__nativeTextDecode" as NSString)

// Timers (execute callback immediately - no real event loop)
var nextTimerId = 1

let nativeSetTimeout: @convention(block) (JSValue, Double) -> Int = { fn, _ in
    let id = nextTimerId; nextTimerId += 1
    fn.call(withArguments: [])
    return id
}
ctx.setObject(nativeSetTimeout, forKeyedSubscript: "__nativeSetTimeout" as NSString)

let nativeClearTimeout: @convention(block) (Int) -> Void = { _ in }
ctx.setObject(nativeClearTimeout, forKeyedSubscript: "__nativeClearTimeout" as NSString)

let nativeSetInterval: @convention(block) (JSValue, Double) -> Int = { fn, _ in
    let id = nextTimerId; nextTimerId += 1
    fn.call(withArguments: [])
    return id
}
ctx.setObject(nativeSetInterval, forKeyedSubscript: "__nativeSetInterval" as NSString)

let nativeClearInterval: @convention(block) (Int) -> Void = { _ in }
ctx.setObject(nativeClearInterval, forKeyedSubscript: "__nativeClearInterval" as NSString)

// __nativePostMessage(msg, transfer)
let nativePostMessage: @convention(block) (JSValue, JSValue) -> Void = { msg, _ in
    if msg.isObject, let obj = msg.toObject() {
        print("postMessage:", obj)
    } else {
        print("postMessage:", msg.toString() ?? "<non-string>")
    }
}
ctx.setObject(nativePostMessage, forKeyedSubscript: "__nativePostMessage" as NSString)

// __nativeReadFile(path) -> String
let nativeReadFile: @convention(block) (String) -> String = { path in
    do {
        return try readFile(path)
    } catch {
        fputs("Error reading file: \(path): \(error)\n", stderr)
        return ""
    }
}
ctx.setObject(nativeReadFile, forKeyedSubscript: "__nativeReadFile" as NSString)

// __nativeReadFileBytes(path) -> [Int] (array of byte values)
let nativeReadFileBytes: @convention(block) (String) -> [Int] = { path in
    guard let data = FileManager.default.contents(atPath: path) else {
        fputs("Error reading file bytes: \(path)\n", stderr)
        return []
    }
    return data.map { Int($0) }
}
ctx.setObject(nativeReadFileBytes, forKeyedSubscript: "__nativeReadFileBytes" as NSString)

// __nativeReportResult(json) - captures test result
let nativeReportResult: @convention(block) (String) -> Void = { json in
    resultReceived = true
    print(json)
    if let data = json.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let pass = obj["pass"] as? Bool {
        testsPassed = pass
    } else {
        testsPassed = false
    }
}
ctx.setObject(nativeReportResult, forKeyedSubscript: "__nativeReportResult" as NSString)

// --- Load and evaluate scripts in order ---

for path in scriptPaths {
    do {
        let source = try readFile(path)
        ctx.evaluateScript(source, withSourceURL: URL(fileURLWithPath: path))
    } catch {
        fputs("Error loading \(path): \(error)\n", stderr)
        exit(1)
    }
}

// Pump the run loop to let async operations (e.g. WebAssembly.instantiate) complete
let deadline = Date(timeIntervalSinceNow: 300) // 5 min timeout
while !resultReceived && Date() < deadline {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
}

// Check that the test reported a result
if !resultReceived {
    fputs("Error: No test result reported (missing __nativeReportResult call)\n", stderr)
    exit(1)
}

exit(testsPassed ? 0 : 1)
