#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <AsyncElegantOTA.h>

// Add web server for OTA
AsyncWebServer server(80);

void setup() {
    // ... existing setup code ...
    
    // Connect to WiFi
    WiFi.begin("theWebz", "07N13Tek88");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("");
    Serial.println("WiFi connected");
    Serial.println("IP address: ");
    Serial.println(WiFi.localIP());

    // Initialize OTA server
    AsyncElegantOTA.begin(&server);    // Start ElegantOTA
    server.begin();
    Serial.println("HTTP server started");
    
    // ... rest of existing setup code ...
}

void loop() {
    // ... existing loop code ...
    
    // No need to add anything to the loop for OTA
    // AsyncElegantOTA handles everything in the background
} 