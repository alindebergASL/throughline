import { Module } from "@nestjs/common";
import { TrustedObjectiveController } from "./trusted-objective.controller.js";
import { TrustedObjectiveGuard } from "./trusted-objective.guard.js";
import { TrustedObjectiveRuntime } from "./trusted-objective.runtime.js";

@Module({
  controllers: [TrustedObjectiveController],
  providers: [TrustedObjectiveGuard, TrustedObjectiveRuntime]
})
export class TrustedObjectiveModule {}
