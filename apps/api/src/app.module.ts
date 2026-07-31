import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { B1AccountOperationsModule } from "./b1-account-operations/b1-account-operations.module.js";
import { B2TruthModule } from "./b2-truth/b2-truth.module.js";

@Module({
  imports: [B1AccountOperationsModule, B2TruthModule],
  controllers: [HealthController],
  providers: [HealthService]
})
export class AppModule {}
