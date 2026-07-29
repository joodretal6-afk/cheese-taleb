// Copyright Project Phoenix. Client-side bridge to the Auth microservice.
#include "PhoenixAuthSubsystem.h"

#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

void UPhoenixAuthSubsystem::Login(const FString& Email, const FString& Password)
{
    const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("email"), Email);
    Json->SetStringField(TEXT("password"), Password);

    FString Body;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
    FJsonSerializer::Serialize(Json, Writer);

    PostJson(TEXT("/auth/login"), Body);
}

void UPhoenixAuthSubsystem::Register(const FString& Email, const FString& Username, const FString& Password)
{
    const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("email"), Email);
    Json->SetStringField(TEXT("username"), Username);
    Json->SetStringField(TEXT("password"), Password);

    FString Body;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
    FJsonSerializer::Serialize(Json, Writer);

    PostJson(TEXT("/auth/register"), Body);
}

void UPhoenixAuthSubsystem::PostJson(const FString& Path, const FString& Body)
{
    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BaseUrl + Path);
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetContentAsString(Body);
    Request->OnProcessRequestComplete().BindUObject(this, &UPhoenixAuthSubsystem::HandleResponse);
    Request->ProcessRequest();
}

void UPhoenixAuthSubsystem::HandleResponse(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful)
{
    if (!bWasSuccessful || !Response.IsValid())
    {
        OnAuthCompleted.Broadcast(false, TEXT("Network error — could not reach the Auth service."));
        return;
    }

    const int32 Code = Response->GetResponseCode();
    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
    FJsonSerializer::Deserialize(Reader, Json);

    if (Code >= 200 && Code < 300 && Json.IsValid())
    {
        AccessToken = Json->GetStringField(TEXT("accessToken"));
        const TSharedPtr<FJsonObject>* User;
        if (Json->TryGetObjectField(TEXT("user"), User))
        {
            UserId = (*User)->GetStringField(TEXT("id"));
        }
        OnAuthCompleted.Broadcast(true, TEXT("Authenticated."));
        return;
    }

    FString Message = TEXT("Authentication failed.");
    if (Json.IsValid())
    {
        Json->TryGetStringField(TEXT("message"), Message);
    }
    OnAuthCompleted.Broadcast(false, Message);
}
