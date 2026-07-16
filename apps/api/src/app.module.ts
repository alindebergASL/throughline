import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { B1AccountOperationsModule } from "./b1-account-operations/b1-account-operations.module.js";

@Module({
  imports: [B1AccountOperationsModule],
  controllers: [HealthController],
  providers: [HealthService]
})
export class AppModule {}
