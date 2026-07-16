import { Module } from "@nestjs/common";
import { B1AccountOperationsController } from "./b1-account-operations.controller.js";
import { B1AccountOperationsGuard } from "./b1-account-operations.guard.js";
import { B1AccountOperationsRuntime } from "./b1-account-operations.runtime.js";

@Module({
  controllers: [B1AccountOperationsController],
  providers: [B1AccountOperationsGuard, B1AccountOperationsRuntime]
})
export class B1AccountOperationsModule {}
