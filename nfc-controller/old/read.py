#!/usr/bin/env python

import RPi.GPIO as GPIO
from mfrc522 import SimpleMFRC522, MFRC522
import time

class RFIDReader:
    def __init__(self):
        self.reader = SimpleMFRC522()
        self.MIFAREReader = MFRC522()
        
    def read_tag(self, max_retries=3):
        """
        Attempts to read an RFID tag with explicit authentication
        """
        for attempt in range(max_retries):
            try:
                print(f"Please place tag to read (attempt {attempt + 1}/{max_retries})")
                
                # Wait for a card
                while True:
                    (status, TagType) = self.MIFAREReader.MFRC522_Request(self.MIFAREReader.PICC_REQIDL)
                    if status == self.MIFAREReader.MI_OK:
                        break
                    time.sleep(0.1)
                
                # Get the UID of the card
                (status, uid) = self.MIFAREReader.MFRC522_Anticoll()
                if status != self.MIFAREReader.MI_OK:
                    continue

                # Select the scanned tag
                self.MIFAREReader.MFRC522_SelectTag(uid)
                
                # Authenticate
                status = self.MIFAREReader.MFRC522_Auth(
                    self.MIFAREReader.PICC_AUTHENT1A,
                    8,  # Block number
                    [0x7F, 0x07, 0x88, 0x40],  # Default key [FF FF FF FF FF FF]
                    uid)
                
                if status != self.MIFAREReader.MI_OK:
                    print("Authentication error")
                    continue
                
                # Now try to read
                id, text = self.reader.read()
                return id, text.strip() if text else ""
                
            except Exception as e:
                print(f"Error reading tag: {str(e)}")
                print("Please try again...")
                time.sleep(1)
                continue
            finally:
                self.MIFAREReader.MFRC522_StopCrypto1()
                
        return None, None

    def cleanup(self):
        GPIO.cleanup()

def main():
    reader = RFIDReader()
    try:
        while True:
            id, text = reader.read_tag()
            if id:
                print(f"\nTag ID: {id}")
                print(f"Tag Text: {text if text else 'No text stored'}")
                retry = input("\nWould you like to read another tag? (y/n): ")
                if retry.lower() != 'y':
                    break
            else:
                print("Failed to read tag after multiple attempts")
                break
    finally:
        reader.cleanup()

if __name__ == "__main__":
    main()
