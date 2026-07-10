import fastf1
fastf1.Cache.enable_cache('../cache')

race_session = fastf1.get_session(2023, 14, 'R')
race_session.load()

lap = race_session.laps.iloc[0]
tel = lap.get_car_data()
print(tel.columns.tolist())