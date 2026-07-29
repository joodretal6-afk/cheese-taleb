// Copyright Project Phoenix. Player character.
#include "PhoenixCharacter.h"

#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/Controller.h"
#include "GameFramework/Pawn.h"

APhoenixCharacter::APhoenixCharacter()
{
    PrimaryActorTick.bCanEverTick = false;

    // Rotate toward movement, not toward the controller — standard TPS feel.
    bUseControllerRotationYaw = false;
    if (UCharacterMovementComponent* Move = GetCharacterMovement())
    {
        Move->bOrientRotationToMovement = true;
        Move->RotationRate = FRotator(0.f, 540.f, 0.f);
        Move->MaxWalkSpeed = 600.f;
        Move->JumpZVelocity = 500.f;
        Move->AirControl = 0.35f;
    }
}

void APhoenixCharacter::BeginPlay()
{
    Super::BeginPlay();

    if (const APlayerController* PC = Cast<APlayerController>(GetController()))
    {
        if (UEnhancedInputLocalPlayerSubsystem* Subsystem =
                ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
        {
            if (MappingContext)
            {
                Subsystem->AddMappingContext(MappingContext, 0);
            }
        }
    }
}

void APhoenixCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);

    if (UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent))
    {
        if (MoveAction) Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &APhoenixCharacter::Move);
        if (LookAction) Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &APhoenixCharacter::Look);
        if (JumpAction)
        {
            Input->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
            Input->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
        }
        if (InteractAction) Input->BindAction(InteractAction, ETriggerEvent::Started, this, &APhoenixCharacter::Interact);
    }
}

void APhoenixCharacter::Move(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    if (!Controller) return;

    const FRotator YawRot(0.f, Controller->GetControlRotation().Yaw, 0.f);
    const FVector Forward = FRotationMatrix(YawRot).GetUnitAxis(EAxis::X);
    const FVector Right = FRotationMatrix(YawRot).GetUnitAxis(EAxis::Y);
    AddMovementInput(Forward, Axis.Y);
    AddMovementInput(Right, Axis.X);
}

void APhoenixCharacter::Look(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddControllerYawInput(Axis.X);
    AddControllerPitchInput(Axis.Y);
}

void APhoenixCharacter::Interact()
{
    // Line-trace straight ahead for something to enter.
    const FVector Start = GetActorLocation();
    const FVector End = Start + GetActorForwardVector() * InteractReach;

    FHitResult Hit;
    FCollisionQueryParams Params;
    Params.AddIgnoredActor(this);
    if (!GetWorld()->LineTraceSingleByChannel(Hit, Start, End, ECC_Pawn, Params)) return;

    APawn* Vehicle = Cast<APawn>(Hit.GetActor());
    if (!Vehicle || Vehicle == this) return;

    // GTA-style: possess the vehicle and hide the on-foot pawn. Exiting reverses
    // this (handled by the vehicle pawn's own Interact).
    if (AController* C = GetController())
    {
        C->Possess(Vehicle);
        SetActorHiddenInGame(true);
        SetActorEnableCollision(false);
    }
}
