import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  app.enableCors()
  const port = Number(process.env.PORT ?? 4003)
  await app.listen(port)
  // eslint-disable-next-line no-console
  console.log(`[inventory] listening on :${port}`)
}

void bootstrap()
