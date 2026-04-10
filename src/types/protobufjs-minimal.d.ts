// Type shim so ts-proto generated code can resolve "protobufjs/minimal" under NodeNext.
declare module "protobufjs/minimal" {
  export * from "protobufjs";
}
