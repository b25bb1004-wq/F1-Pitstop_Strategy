import fastf1
import pandas as pd
import os
import time

fastf1.Cache.enable_cache('../cache')
os.makedirs('../data', exist_ok=True)

for year in range(2021, 2026):
    schedule = fastf1.get_event_schedule(year)
    race_schedule = schedule[schedule['RoundNumber'] > 0]
    for round_number in race_schedule['RoundNumber']:
        try:
            race_session = fastf1.get_session(year, round_number, 'R')
            race_session.load()
        except Exception as e:
            print(f"Error while loading race session {year} {round_number}")
            print(e)
            continue
        try:
            lap_data = race_session.laps                  #get lap data from race session
            laps = lap_data[lap_data['IsAccurate']].copy()
            laps['LapTime'] = laps['LapTime'].dt.total_seconds() #convert lap time to seconds
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
        
        except Exception as e: #handles NaN error 

            print(f"Error while creating buckets for {circuit_location}, {year}")
            print(e)
            continue   
       
        laps['year'] = year                #add year and location to each lap
        laps['location'] = circuit_location
        laps.to_csv(f"../data/{circuit_location}.csv", mode='a', header=not os.path.exists(f"../data/{circuit_location}.csv"), index=False)   #save laps to csv file
        time.sleep(4)
        


        