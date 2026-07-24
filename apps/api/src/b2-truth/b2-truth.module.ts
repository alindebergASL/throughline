import { Module } from "@nestjs/common";
import { B2TruthController } from "./b2-truth.controller.js";
import { B2TruthGuard } from "./b2-truth.guard.js";
import { B2TruthRuntime } from "./b2-truth.runtime.js";

@Module({
  controllers: [B2TruthController],
  providers: [B2TruthGuard, B2TruthRuntime]
})
export class B2TruthModule {}
