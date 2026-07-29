// Copyright Project Phoenix. Default game mode.
#include "PhoenixGameMode.h"
#include "../Player/PhoenixCharacter.h"

APhoenixGameMode::APhoenixGameMode()
{
    DefaultPawnClass = APhoenixCharacter::StaticClass();
}
