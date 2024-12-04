#!/usr/bin/env python

#!/usr/bin/env python

import RPi.GPIO as GPIO
from mfrc522 import SimpleMFRC522
import time

class RFIDWriter:
    def __init__(self):
        self.reader = SimpleMFRC522()
        
    def write_tag(self, text, max_retries=3):
        """
        Attempts to write to an RFID tag with retry logic
        """
        for attempt in range(max_retries):
            try:
                print(f"\nPlease place tag to write (attempt {attempt + 1}/{max_retries})")
                self.reader.write(text)
                print("\nWrite successful!")
                return True
            except Exception as e:
                print(f"Error writing to tag: {str(e)}")
                print("Please try again...")
                time.sleep(1)
                continue
        return False

    def verify_write(self):
        """
        Verifies that the data was written correctly
        """
        try:
            print("\nPlease keep the tag in place to verify...")
            time.sleep(1)  # Brief pause before reading
            id, text = self.reader.read()
            return text.strip()
        except Exception as e:
            print(f"Error verifying write: {str(e)}")
            return None

    def cleanup(self):
        GPIO.cleanup()

def main():
    writer = RFIDWriter()
    try:
        while True:
            text = input('\nEnter the text to write to the tag: ').strip()
            if not text:
                print("Text cannot be empty. Please try again.")
                continue
                
            if writer.write_tag(text):
                # Verify the write was successful
                verified_text = writer.verify_write()
                if verified_text == text:
                    print("\nVerification successful - data was written correctly!")
                else:
                    print("\nWarning: Verification failed - written data may not be correct")
                    print(f"Expected: {text}")
                    print(f"Read back: {verified_text}")
            else:
                print("\nFailed to write to tag after multiple attempts")
            
            retry = input("\nWould you like to write to another tag? (y/n): ")
            if retry.lower() != 'y':
                break
    finally:
        writer.cleanup()

if __name__ == "__main__":
    main()
