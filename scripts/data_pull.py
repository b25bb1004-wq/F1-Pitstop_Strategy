import fastf1
from fastf1.exceptions import RateLimitExceededError
import pandas as pd
import os
import time
import sys

fastf1.Cache.enable_cache('../cache')
os.makedirs('../data', exist_ok=True)

def already_pulled(csv_path, year, round_number):
    #skip races that are already in the circuit file, so re-runs after a
    #rate-limit stop don't append the same race again
    if not os.path.exists(csv_path):
        return False
    existing = pd.read_csv(csv_path, usecols=lambda c: c in ('year', 'round_number'), low_memory=False)
    year_rows = existing[existing['year'] == year]
    if year_rows.empty:
        return False
    if 'round_number' not in year_rows.columns:
        return True #old-schema file with no round info: treat the year as pulled
    rounds = pd.to_numeric(year_rows['round_number'], errors='coerce')
    if rounds.isna().all():
        return True #round column corrupted for this year (old shifted rows): treat as pulled
    return (rounds == round_number).any()

def append_matching_schema(laps, csv_path):
    #files written by older script versions have different columns - appending a
    #mismatched row count shifts every value left/right and corrupts the tail
    #columns (this is how the location column got corrupted). Align to the
    #existing header before appending.
    if os.path.exists(csv_path):
        header = pd.read_csv(csv_path, nrows=0).columns
        laps = laps.reindex(columns=header)
        laps.to_csv(csv_path, mode='a', header=False, index=False)
    else:
        laps.to_csv(csv_path, index=False)

for year in range(2021, 2026):
    schedule = fastf1.get_event_schedule(year)
    race_schedule = schedule[schedule['RoundNumber'] > 0]
    for round_number, schedule_location in zip(race_schedule['RoundNumber'], race_schedule['Location']):
        if already_pulled(f"../data/{schedule_location}.csv", year, round_number):
            print(f"skipping {year} round {round_number} ({schedule_location}) - already pulled")
            continue
        try:
            try:
                race_session = fastf1.get_session(year, round_number, 'R')
                race_session.load()

            except RateLimitExceededError:
                print("rate limit exceeded - stopping")
                sys.exit()
            except Exception as e:
                print(f"Error while loading race session {year} {round_number}")
                print(e)
                continue
            
            try:
                lap_data = race_session.laps                  #get lap data from race session
                laps = lap_data[lap_data['IsAccurate']].copy()
                laps['LapTime'] = laps['LapTime'].dt.total_seconds() #convert lap time to seconds
            except RateLimitExceededError:
                print("rate limit exceeded - stopping")
                sys.exit()
            except Exception as e:
                print(f"Error while loading lap data {lap_data}")
                print(e)
                continue
            

            circuit_location = race_session.event['Location'] #get circuit location from event
            weather = race_session.weather_data #get weather data from race session

            try:

                total_laps = laps['LapNumber'].max()    #get total laps from race session
                
                if pd.isna(total_laps): #handles NaN error
                    raise ValueError("total_laps is NaN") 
                race_edges = [0, total_laps * 0.25, total_laps * 0.5, total_laps * 0.75, total_laps]            #create buckets for weather data
                laps['WeatherBucket'] = pd.cut(laps['LapNumber'], bins = race_edges, labels = [1, 2, 3, 4], include_lowest = True)

            except RateLimitExceededError:
                print("rate limit exceeded - stopping")
                sys.exit()
            
            except Exception as e: #handles NaN error 
                print(f"Error while creating buckets for {circuit_location}, {year}")
                print(e)
                continue 

            try:
                laps['year'] = year                #add year, round and location to each lap
                laps['round_number'] = round_number
                laps['location'] = circuit_location
                append_matching_schema(laps, f"../data/{circuit_location}.csv")   #save laps to csv file
                time.sleep(4)
            except RateLimitExceededError:
                print("rate limit exceeded - stopping")
                sys.exit()
        except RateLimitExceededError:
            print("rate limit exceeded - stopping")
            sys.exit()


        